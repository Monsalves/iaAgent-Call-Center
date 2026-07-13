import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BullMqCampaignQueue, mapTwilioStatus } from "../src/call-service/bullmq-queue.js";
import { parseContactsCsv } from "../src/call-service/csv.js";
import { CampaignStore } from "../src/call-service/store.js";

function createAttempt(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new CampaignStore(path.join(directory, "campaigns.json"));
  const campaign = store.createCampaign({ name: "Queue test" });
  store.addContacts(campaign.id, parseContactsCsv("nombre,telefono\nAna,+56911111111\n"));
  const claimed = store.claimNextContact(campaign.id, 3);
  return { store, campaign, claimed };
}

function createQueueDouble(store, overrides = {}) {
  const queue = Object.create(BullMqCampaignQueue.prototype);
  Object.assign(queue, {
    store,
    waiters: new Map(),
    callStatusPollIntervalMs: 1,
    callStatusTimeoutMs: 100,
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
