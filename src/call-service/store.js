import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const INITIAL_DATA = { version: 1, campaigns: [], contacts: [], attempts: [], events: [] };
const TERMINAL_CONTACT_STATES = new Set(["completed", "no_answer", "invalid_number", "error"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class CampaignStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return clone(INITIAL_DATA);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return { ...clone(INITIAL_DATA), ...parsed };
    } catch (error) {
      throw new Error(`Cannot read campaign store ${this.filePath}: ${error.message}`);
    }
  }

  save() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, this.filePath);
  }

  mutate(fn) {
    const result = fn(this.data);
    this.save();
    return clone(result);
  }

  snapshot() {
    return clone(this.data);
  }

  createCampaign({ name, prompt = "" }) {
    return this.mutate((data) => {
      const now = new Date().toISOString();
      const campaign = { id: crypto.randomUUID(), name, prompt, status: "draft", createdAt: now, updatedAt: now };
      data.campaigns.push(campaign);
      this.event(data, campaign.id, null, null, "campaign_created", { name });
      return campaign;
    });
  }

  addContacts(campaignId, contacts) {
    return this.mutate((data) => {
      const campaign = this.findCampaign(data, campaignId);
      if (!campaign) throw new Error("Campaign not found.");
      if (data.contacts.some((contact) => contact.campaignId === campaignId)) {
        throw new Error("Campaign already has contacts; create another campaign for a new CSV.");
      }
      const now = new Date().toISOString();
      const records = contacts.map((contact, index) => ({
        id: crypto.randomUUID(), campaignId, sequence: index, name: contact.name, phone: contact.phone,
        context: contact.context, status: "pending", attempts: 0, nextAttemptAt: null,
        createdAt: now, updatedAt: now
      }));
      data.contacts.push(...records);
      campaign.status = "ready";
      campaign.updatedAt = now;
      this.event(data, campaignId, null, null, "contacts_imported", { count: records.length });
      return records;
    });
  }

  setCampaignStatus(campaignId, status) {
    return this.mutate((data) => {
      const campaign = this.findCampaign(data, campaignId);
      if (!campaign) throw new Error("Campaign not found.");
      campaign.status = status;
      campaign.updatedAt = new Date().toISOString();
      this.event(data, campaignId, null, null, `campaign_${status}`);
      return campaign;
    });
  }

  getCampaign(campaignId) {
    const data = this.snapshot();
    const campaign = this.findCampaign(data, campaignId);
    if (!campaign) return null;
    const contacts = data.contacts.filter((contact) => contact.campaignId === campaignId);
    const attempts = data.attempts.filter((attempt) => attempt.campaignId === campaignId);
    return { ...campaign, contacts, attempts, events: data.events.filter((event) => event.campaignId === campaignId) };
  }

  listCampaigns() {
    const data = this.snapshot();
    return data.campaigns.map((campaign) => ({
      ...campaign,
      summary: data.contacts.filter((contact) => contact.campaignId === campaign.id).reduce((result, contact) => {
        result.total += 1;
        result[contact.status] = (result[contact.status] || 0) + 1;
        return result;
      }, { total: 0 })
    }));
  }

  activeAttemptCount(campaignId) {
    return this.data.attempts.filter((attempt) => attempt.campaignId === campaignId && attempt.status === "active").length;
  }

  claimNextContact(campaignId, maxAttempts) {
    return this.claimContact(campaignId, null, maxAttempts);
  }

  claimContact(campaignId, contactId, maxAttempts) {
    return this.mutate((data) => {
      const now = new Date();
      const contact = data.contacts
        .filter((item) => item.campaignId === campaignId && (!contactId || item.id === contactId) && item.status === "pending" && (!item.nextAttemptAt || new Date(item.nextAttemptAt) <= now))
        .sort((a, b) => a.sequence - b.sequence)[0];
      if (!contact) return null;
      contact.status = "dispatching";
      contact.attempts += 1;
      contact.updatedAt = now.toISOString();
      const attempt = {
        id: crypto.randomUUID(), campaignId, contactId: contact.id, number: contact.phone,
        attemptNumber: contact.attempts, status: "creating", twilioCallSid: null,
        startedAt: now.toISOString(), endedAt: null, durationSeconds: null, resultCode: null,
        errorMessage: null, transcript: [], maxAttempts
      };
      data.attempts.push(attempt);
      this.event(data, campaignId, contact.id, attempt.id, "attempt_claimed", { attemptNumber: contact.attempts });
      return { contact, attempt };
    });
  }

  markCallCreated(attemptId, callSid) {
    return this.mutate((data) => {
      const attempt = data.attempts.find((item) => item.id === attemptId);
      if (!attempt) return null;
      const contact = data.contacts.find((item) => item.id === attempt.contactId);
      attempt.status = "active";
      attempt.twilioCallSid = callSid;
      if (contact) { contact.status = "in_progress"; contact.updatedAt = new Date().toISOString(); }
      this.event(data, attempt.campaignId, attempt.contactId, attempt.id, "twilio_call_created", { callSid });
      return attempt;
    });
  }

  markCreationFailure(attemptId, error, retryDelayMs) {
    return this.finishAttempt(attemptId, { resultCode: "provider_error", errorMessage: error, retryDelayMs });
  }

  finishAttempt(attemptId, { resultCode, durationSeconds = null, errorMessage = null, retryDelayMs = 0 }) {
    return this.mutate((data) => {
      const attempt = data.attempts.find((item) => item.id === attemptId);
      if (!attempt || attempt.status === "completed") return attempt;
      const contact = data.contacts.find((item) => item.id === attempt.contactId);
      const now = new Date();
      attempt.status = "completed";
      attempt.endedAt = now.toISOString();
      attempt.durationSeconds = durationSeconds;
      attempt.resultCode = resultCode;
      attempt.errorMessage = errorMessage;
      if (contact) {
        const retryable = resultCode === "provider_error" && contact.attempts < attempt.maxAttempts;
        contact.status = retryable ? "pending" : mapContactStatus(resultCode);
        contact.nextAttemptAt = retryable ? new Date(now.getTime() + retryDelayMs).toISOString() : null;
        contact.updatedAt = now.toISOString();
      }
      this.event(data, attempt.campaignId, attempt.contactId, attempt.id, "attempt_finished", { resultCode, errorMessage });
      return attempt;
    });
  }

  findAttemptByCallSid(callSid) {
    return clone(this.data.attempts.find((attempt) => attempt.twilioCallSid === callSid) || null);
  }

  appendTranscript(attemptId, role, text, turnId = null) {
    if (!text) return;
    this.mutate((data) => {
      const attempt = data.attempts.find((item) => item.id === attemptId);
      if (attempt && (!turnId || !attempt.transcript.some((turn) => turn.turnId === turnId))) {
        attempt.transcript.push({ role, text, turnId, at: new Date().toISOString() });
      }
      return attempt || {};
    });
  }

  completeCampaignIfDone(campaignId) {
    return this.mutate((data) => {
      const campaign = this.findCampaign(data, campaignId);
      if (!campaign || campaign.status !== "running") return campaign;
      const contacts = data.contacts.filter((contact) => contact.campaignId === campaignId);
      if (contacts.length && contacts.every((contact) => TERMINAL_CONTACT_STATES.has(contact.status))) {
        campaign.status = "completed";
        campaign.updatedAt = new Date().toISOString();
        this.event(data, campaignId, null, null, "campaign_completed");
      }
      return campaign;
    });
  }

  findCampaign(data, campaignId) { return data.campaigns.find((campaign) => campaign.id === campaignId); }
  event(data, campaignId, contactId, attemptId, type, details = {}) {
    data.events.push({ id: crypto.randomUUID(), campaignId, contactId, attemptId, type, details, at: new Date().toISOString() });
  }
}

function mapContactStatus(resultCode) {
  if (["completed", "answered"].includes(resultCode)) return "completed";
  if (["no_answer", "busy", "voicemail"].includes(resultCode)) return "no_answer";
  if (["invalid_number", "failed"].includes(resultCode)) return "invalid_number";
  return "error";
}
