import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { isRetryableResult } from "./store.js";

const TERMINAL_TWILIO_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export function mapTwilioStatus(status, durationSeconds = null, shortCallThresholdSeconds = 8) {
  const normalizedStatus = String(status || "").toLowerCase();
  if (
    normalizedStatus === "completed" &&
    durationSeconds !== null &&
    Number(durationSeconds) < shortCallThresholdSeconds
  ) {
    return "short_call";
  }
  return {
    completed: "completed",
    busy: "busy",
    "no-answer": "no_answer",
    failed: "failed",
    canceled: "provider_error"
  }[normalizedStatus] || null;
}

export class BullMqCampaignQueue {
  constructor({
    store,
    createCall,
    getCallStatus,
    cancelCall,
    redisUrl,
    queueName,
    maxConcurrentCalls,
    maxAttempts,
    retryBaseMs,
    shortCallThresholdSeconds = 8,
    callStatusPollIntervalMs = 5000,
    callStatusTimeoutMs = 300000
  }) {
    this.store = store;
    this.createCall = createCall;
    this.getCallStatus = getCallStatus;
    this.cancelCall = cancelCall;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.shortCallThresholdSeconds = shortCallThresholdSeconds;
    this.callStatusPollIntervalMs = callStatusPollIntervalMs;
    this.callStatusTimeoutMs = callStatusTimeoutMs;
    this.waiters = new Map();
    this.deletedCampaignIds = new Set();
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
    this.recoveryPromise = this.recoverRunningCampaigns().catch((error) => {
      console.error("[bullmq] startup recovery failed", error);
    });
  }

  ensureWorkerRunning() {
    if (this.worker.isRunning()) return;
    this.worker.run().catch((error) => console.error("[bullmq] worker stopped", error));
  }

  async recoverRunningCampaigns() {
    await this.queue.waitUntilReady();
    const campaigns = this.store.listCampaigns().filter((campaign) => campaign.status === "running");
    if (!campaigns.length) return;
    await this.queue.resume();
    for (const campaign of campaigns) {
      await this.enqueuePendingContacts(campaign.id);
      const activeAttempts = this.store.getCampaign(campaign.id)?.attempts.filter(
        (attempt) => ["creating", "active"].includes(attempt.status)
      ) || [];
      for (const attempt of activeAttempts) {
        if (attempt.twilioCallSid) {
          this.waitForAttempt(attempt.id, attempt.twilioCallSid)
            .then(() => this.store.completeCampaignIfDone(campaign.id))
            .catch((error) => console.error("[bullmq] attempt recovery failed", {
              attemptId: attempt.id,
              error: error.message
            }));
        } else {
          this.store.finishAttempt(attempt.id, {
            resultCode: "status_unknown",
            errorMessage: "Service restarted before Twilio returned a call SID."
          });
        }
      }
      this.store.completeCampaignIfDone(campaign.id);
    }
    this.ensureWorkerRunning();
  }

  async enqueueContacts(campaignId, contacts) {
    for (const contact of contacts) {
      const existingJob = await this.queue.getJob(contact.id);
      if (!existingJob) continue;
      const state = await existingJob.getState();
      if (["completed", "failed"].includes(state)) {
        await existingJob.remove();
      }
    }
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
    await this.recoveryPromise;
    await this.queue.waitUntilReady();
    const campaign = this.store.setCampaignStatus(campaignId, "running");
    await this.enqueuePendingContacts(campaignId);
    await this.queue.resume();
    this.ensureWorkerRunning();
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

  async deleteCampaign(campaignId) {
    const campaign = this.store.getCampaign(campaignId);
    if (!campaign) return null;
    this.deletedCampaignIds.add(campaignId);

    for (const attempt of campaign.attempts.filter((item) => item.status !== "completed")) {
      if (attempt.twilioCallSid) {
        await this.cancelCallIfActive(attempt.twilioCallSid);
      }
      const completedAttempt = this.store.finishAttempt(attempt.id, {
        resultCode: "canceled_by_user",
        errorMessage: "Campaign deleted by an administrator."
      });
      this.completeAttempt(completedAttempt);
    }

    await this.removeCampaignJobs(campaignId);
    return this.store.deleteCampaign(campaignId);
  }

  async cancelCallIfActive(callSid) {
    if (!this.cancelCall) return;
    if (this.getCallStatus) {
      try {
        const call = await this.getCallStatus(callSid);
        if (TERMINAL_TWILIO_STATUSES.has(String(call?.status || "").toLowerCase())) return;
      } catch (error) {
        console.warn("[bullmq] Twilio status check before cancellation failed", {
          callSid,
          error: error.message
        });
      }
    }
    try {
      await this.cancelCall(callSid);
    } catch (error) {
      console.warn("[bullmq] Twilio call cancellation failed", { callSid, error: error.message });
    }
  }

  async removeCampaignJobs(campaignId) {
    await this.queue.waitUntilReady();
    const jobs = await this.queue.getJobs([
      "wait",
      "delayed",
      "paused",
      "prioritized",
      "failed",
      "completed"
    ]);
    await Promise.all(jobs
      .filter((job) => job.data?.campaignId === campaignId)
      .map((job) => job.remove().catch((error) => {
        console.warn("[bullmq] campaign job removal failed", { jobId: job.id, error: error.message });
      })));
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
      if (this.deletedCampaignIds.has(campaignId) || !this.store.getCampaign(campaignId)) {
        await this.cancelCallIfActive(call.sid);
        return;
      }
      const markedAttempt = this.store.markCallCreated(claimed.attempt.id, call.sid);
      if (!markedAttempt) {
        await this.cancelCallIfActive(call.sid);
        return;
      }
      const finalAttempt = await this.waitForAttempt(claimed.attempt.id, call.sid);
      this.store.completeCampaignIfDone(campaignId);
      if (this.contactNeedsRetry(campaignId, contactId)) {
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
    if (!attempt) return;
    const resolve = this.waiters.get(attempt.id);
    if (resolve) {
      this.waiters.delete(attempt.id);
      resolve(attempt);
    }
  }

  waitForAttempt(attemptId, callSid) {
    const existing = this.store.snapshot().attempts.find((attempt) => attempt.id === attemptId);
    if (existing?.status === "completed") return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;
      const startedAt = Date.now();
      const finish = (attempt) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        resolve(attempt);
      };
      const poll = async () => {
        if (settled) return;
        const storedAttempt = this.store.snapshot().attempts.find((attempt) => attempt.id === attemptId);
        if (storedAttempt?.status === "completed") {
          this.completeAttempt(storedAttempt);
          return;
        }
        if (Date.now() - startedAt >= this.callStatusTimeoutMs) {
          const timedOutAttempt = this.store.finishAttempt(attemptId, {
            resultCode: "status_unknown",
            errorMessage: `Twilio did not report a terminal status within ${this.callStatusTimeoutMs} ms.`
          });
          this.completeAttempt(timedOutAttempt);
          return;
        }
        try {
          if (this.getCallStatus && callSid) {
            const call = await this.getCallStatus(callSid);
            const status = String(call?.status || "").toLowerCase();
            if (TERMINAL_TWILIO_STATUSES.has(status)) {
              const resultCode = mapTwilioStatus(
                status,
                call.duration,
                this.shortCallThresholdSeconds
              );
              const reconciledAttempt = this.store.finishAttempt(attemptId, {
                resultCode,
                durationSeconds: Number(call.duration || 0),
                errorMessage: call.errorMessage || null,
                retryDelayMs: isRetryableResult(resultCode)
                  ? this.retryBaseMs * 2 ** (storedAttempt.attemptNumber - 1)
                  : 0
              });
              this.completeAttempt(reconciledAttempt);
              return;
            }
          }
        } catch (error) {
          console.warn("[bullmq] Twilio status poll failed", { attemptId, callSid, error: error.message });
        }
        pollTimer = setTimeout(poll, this.callStatusPollIntervalMs);
      };
      this.waiters.set(attemptId, finish);
      const afterRegistration = this.store.snapshot().attempts.find((attempt) => attempt.id === attemptId);
      if (afterRegistration?.status === "completed") {
        this.completeAttempt(afterRegistration);
        return;
      }
      pollTimer = setTimeout(poll, this.callStatusPollIntervalMs);
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
