import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

export class BullMqCampaignQueue {
  constructor({ store, createCall, redisUrl, queueName, maxConcurrentCalls, maxAttempts, retryBaseMs }) {
    this.store = store;
    this.createCall = createCall;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.waiters = new Map();
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => console.error("[bullmq] redis connection error", error.message));
    this.queue = new Queue(queueName, { connection: this.connection });
    this.worker = new Worker(queueName, (job) => this.process(job), {
      connection: this.connection,
      concurrency: maxConcurrentCalls,
      autorun: false
    });
    this.worker.on("error", (error) => console.error("[bullmq] worker error", error));
    this.worker.on("failed", (job, error) => console.error("[bullmq] job failed", { jobId: job?.id, error: error.message }));
  }

  async enqueueContacts(campaignId, contacts) {
    await this.queue.addBulk(contacts.map((contact) => ({
      name: "outbound-call",
      data: { campaignId, contactId: contact.id },
      opts: {
        jobId: contact.id,
        attempts: this.maxAttempts,
        backoff: { type: "exponential", delay: this.retryBaseMs },
        removeOnComplete: 1000,
        removeOnFail: false
      }
    })));
  }

  async enqueuePendingContacts(campaignId) {
    const campaign = this.store.getCampaign(campaignId);
    const pendingContacts = campaign?.contacts.filter((contact) => contact.status === "pending") || [];
    await this.enqueueContacts(campaignId, pendingContacts);
  }

  async start(campaignId) {
    await this.queue.waitUntilReady();
    const campaign = this.store.setCampaignStatus(campaignId, "running");
    await this.enqueuePendingContacts(campaignId);
    await this.queue.resume();
    this.worker.run().catch((error) => console.error("[bullmq] worker stopped", error));
    return campaign;
  }

  async pause(campaignId) {
    const campaign = this.store.setCampaignStatus(campaignId, "paused");
    await this.queue.pause();
    return campaign;
  }

  async resume(campaignId) {
    return this.start(campaignId);
  }

  async process(job) {
    const { campaignId, contactId } = job.data;
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign || campaign.status !== "running") return;
    const claimed = this.store.claimContact(campaignId, contactId, this.maxAttempts);
    if (!claimed) {
      if (this.contactNeedsRetry(campaignId, contactId)) throw new Error("Contact retry is not due yet.");
      return;
    }
    try {
      const call = await this.createCall({
        ...claimed.contact,
        campaignId,
        attemptId: claimed.attempt.id,
        campaignPrompt: campaign.prompt
      });
      this.store.markCallCreated(claimed.attempt.id, call.sid);
      const finalAttempt = await this.waitForAttempt(claimed.attempt.id);
      this.store.completeCampaignIfDone(campaignId);
      if (this.contactNeedsRetry(campaignId, contactId) || finalAttempt?.resultCode === "provider_error") {
        throw new Error("Retryable provider failure.");
      }
    } catch (error) {
      const attempt = this.store.snapshot().attempts.find((item) => item.id === claimed.attempt.id);
      if (attempt?.status !== "completed") {
        const delay = this.retryBaseMs * 2 ** (claimed.attempt.attemptNumber - 1);
        this.store.markCreationFailure(claimed.attempt.id, error.message || String(error), delay);
      }
      this.store.completeCampaignIfDone(campaignId);
      throw error;
    }
  }

  completeAttempt(attempt) {
    const resolve = this.waiters.get(attempt.id);
    if (resolve) {
      this.waiters.delete(attempt.id);
      resolve(attempt);
    }
  }

  waitForAttempt(attemptId) {
    const existing = this.store.snapshot().attempts.find((attempt) => attempt.id === attemptId);
    if (existing?.status === "completed") return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.set(attemptId, resolve);
      const afterRegistration = this.store.snapshot().attempts.find((attempt) => attempt.id === attemptId);
      if (afterRegistration?.status === "completed") this.completeAttempt(afterRegistration);
    });
  }

  contactNeedsRetry(campaignId, contactId) {
    return this.store.getCampaign(campaignId)?.contacts.find((contact) => contact.id === contactId)?.status === "pending";
  }

  async close() {
    await this.worker.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
