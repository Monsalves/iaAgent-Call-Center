import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BullMqCampaignQueue, mapTwilioStatus } from "../src/call-service/bullmq-queue.js";
import { parseContactsCsv } from "../src/call-service/csv.js";
import { CampaignStore } from "../src/call-service/store.js";
import { AzureRealtimeSession } from "../src/shared/azureRealtimeSession.js";

test("requests an initial assistant response when the realtime socket is open", () => {
  const sent = [];
  const realtimeSession = Object.create(AzureRealtimeSession.prototype);
  Object.assign(realtimeSession, {
    closed: false,
    session: {
      socket: { readyState: 1, OPEN: 1 },
      send: (event) => sent.push(event)
    }
  });

  assert.equal(realtimeSession.requestInitialResponse(), true);
  assert.deepEqual(sent, [{ type: "response.create" }]);
});

function createAttempt(prefix, maxAttempts = 3) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new CampaignStore(path.join(directory, "campaigns.json"));
  const campaign = store.createCampaign({ name: "Queue test" });
  store.addContacts(campaign.id, parseContactsCsv("nombre,telefono\nAna,+56911111111\n"));
  const claimed = store.claimNextContact(campaign.id, maxAttempts);
  return { store, campaign, claimed };
}

function createQueueDouble(store, overrides = {}) {
  const queue = Object.create(BullMqCampaignQueue.prototype);
  Object.assign(queue, {
    store,
    waiters: new Map(),
    callStatusPollIntervalMs: 1,
    callStatusTimeoutMs: 1000,
    ...overrides
  });
  return queue;
}

test("maps terminal Twilio statuses", () => {
  assert.equal(mapTwilioStatus("completed"), "completed");
  assert.equal(mapTwilioStatus("no-answer"), "no_answer");
  assert.equal(mapTwilioStatus("busy"), "busy");
  assert.equal(mapTwilioStatus("failed"), "failed");
  assert.equal(mapTwilioStatus("canceled"), "provider_error");
  assert.equal(mapTwilioStatus("ringing"), null);
  assert.equal(mapTwilioStatus("completed", 7, 8), "short_call");
  assert.equal(mapTwilioStatus("completed", 8, 8), "completed");
});

test("retries no-answer once and then marks the contact as no answer", () => {
  const { store, campaign, claimed } = createAttempt("call-center-no-answer-", 2);

  store.finishAttempt(claimed.attempt.id, { resultCode: "no_answer" });
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "pending");

  const second = store.claimNextContact(campaign.id, 2);
  store.finishAttempt(second.attempt.id, { resultCode: "no_answer" });
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "no_answer");
  assert.equal(store.getCampaign(campaign.id).contacts[0].attempts, 2);
});

test("retries an early hangup once and then marks it incomplete", () => {
  const { store, campaign, claimed } = createAttempt("call-center-short-call-", 2);

  store.finishAttempt(claimed.attempt.id, { resultCode: "short_call", durationSeconds: 3 });
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "pending");

  const second = store.claimNextContact(campaign.id, 2);
  store.finishAttempt(second.attempt.id, { resultCode: "short_call", durationSeconds: 2 });
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "incomplete");
  assert.equal(store.getCampaign(campaign.id).contacts[0].attempts, 2);
});

test("reconciles a missing callback by polling Twilio", async () => {
  const { store, campaign, claimed } = createAttempt("call-center-poll-");
  store.markCallCreated(claimed.attempt.id, "CA-poll-test");
  const queue = createQueueDouble(store, {
    getCallStatus: async () => ({ status: "completed", duration: "12" })
  });

  const result = await queue.waitForAttempt(claimed.attempt.id, "CA-poll-test");

  assert.equal(result.resultCode, "completed");
  assert.equal(result.durationSeconds, 12);
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "completed");
});

test("releases the worker slot after the status timeout", async () => {
  const { store, campaign, claimed } = createAttempt("call-center-timeout-");
  store.markCallCreated(claimed.attempt.id, "CA-timeout-test");
  const queue = createQueueDouble(store, {
    callStatusPollIntervalMs: 2,
    callStatusTimeoutMs: 10,
    getCallStatus: async () => ({ status: "ringing" })
  });

  const result = await queue.waitForAttempt(claimed.attempt.id, "CA-timeout-test");

  assert.equal(result.resultCode, "status_unknown");
  assert.equal(store.getCampaign(campaign.id).contacts[0].status, "error");
});

test("deleting a campaign removes all persisted related data", () => {
  const { store, campaign, claimed } = createAttempt("call-center-delete-store-");
  store.markCallCreated(claimed.attempt.id, "CA-delete-store");

  const deleted = store.deleteCampaign(campaign.id);

  assert.deepEqual(deleted, {
    id: campaign.id,
    name: campaign.name,
    contacts: 1,
    attempts: 1
  });
  assert.equal(store.getCampaign(campaign.id), null);
  assert.equal(store.snapshot().contacts.length, 0);
  assert.equal(store.snapshot().attempts.length, 0);
  assert.equal(store.snapshot().events.length, 0);
});

test("deleting a running campaign resolves its waiter and clears queued jobs", async () => {
  const { store, campaign, claimed } = createAttempt("call-center-delete-queue-");
  store.setCampaignStatus(campaign.id, "running");
  store.markCallCreated(claimed.attempt.id, "CA-delete-queue");
  let canceledCallSid = null;
  let removed = false;
  const queue = createQueueDouble(store, {
    deletedCampaignIds: new Set(),
    getCallStatus: async () => ({ status: "in-progress" }),
    cancelCall: async (callSid) => { canceledCallSid = callSid; },
    queue: {
      waitUntilReady: async () => undefined,
      getJobs: async () => [{
        id: "job-1",
        data: { campaignId: campaign.id },
        remove: async () => { removed = true; }
      }]
    }
  });
  const waiter = queue.waitForAttempt(claimed.attempt.id, "CA-delete-queue");

  const deleted = await queue.deleteCampaign(campaign.id);
  const resolvedAttempt = await waiter;

  assert.equal(canceledCallSid, "CA-delete-queue");
  assert.equal(resolvedAttempt.resultCode, "canceled_by_user");
  assert.equal(removed, true);
  assert.equal(deleted.id, campaign.id);
  assert.equal(store.getCampaign(campaign.id), null);
});

test("rebuilds terminal BullMQ jobs before starting a pending contact", async () => {
  let removed = false;
  let addedJobs = null;
  const contact = { id: "contact-1" };
  const queue = Object.create(BullMqCampaignQueue.prototype);
  Object.assign(queue, {
    maxAttempts: 3,
    retryBaseMs: 5000,
    queue: {
      getJob: async (jobId) => {
        assert.equal(jobId, contact.id);
        return {
          getState: async () => "completed",
          remove: async () => { removed = true; }
        };
      },
      addBulk: async (jobs) => { addedJobs = jobs; }
    }
  });

  await queue.enqueueContacts("campaign-1", [contact]);

  assert.equal(removed, true);
  assert.equal(addedJobs.length, 1);
  assert.equal(addedJobs[0].data.campaignId, "campaign-1");
  assert.equal(addedJobs[0].data.contactId, contact.id);
});

test("does not remove a BullMQ job that is still waiting", async () => {
  let removed = false;
  const queue = Object.create(BullMqCampaignQueue.prototype);
  Object.assign(queue, {
    maxAttempts: 3,
    retryBaseMs: 5000,
    queue: {
      getJob: async () => ({
        getState: async () => "waiting",
        remove: async () => { removed = true; }
      }),
      addBulk: async () => undefined
    }
  });

  await queue.enqueueContacts("campaign-1", [{ id: "contact-1" }]);

  assert.equal(removed, false);
});
