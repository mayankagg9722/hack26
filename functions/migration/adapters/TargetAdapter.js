/* TargetAdapter — contract every target system implements.
   Targets describe the fields they accept and (later) write mapped records. */

const { NotImplementedError } = require("./SourceAdapter");

class TargetAdapter {
  /** Same meta shape as SourceAdapter. */
  constructor({ id, name, system, mode, description = "" }) {
    this.id = id;
    this.name = name;
    this.system = system;
    this.mode = mode;
    this.description = description;
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      role: "target",
      system: this.system,
      mode: this.mode,
      description: this.description,
    };
  }

  /** @returns {Promise<{ok: boolean, message: string}>} */
  async testConnection() {
    throw new NotImplementedError(this.constructor.name + ".testConnection");
  }

  /** Native fields the target accepts. @returns {Promise<Array<{key,label,type,required?,values?}>>} */
  async getSchema() {
    throw new NotImplementedError(this.constructor.name + ".getSchema");
  }

  /**
   * Workspaces records can be routed into (Freshservice workspaces, etc.).
   * Default: none, meaning the target has a single space.
   * @returns {Promise<Array<{id: string|number, name: string, primary?: boolean}>>}
   */
  async getWorkspaces() {
    return [];
  }

  /**
   * Write transformed records. One result per input record, same order.
   * error.retryable marks transient failures (rate limits, timeouts).
   * @param {object[]} records  target payloads
   * @param {{runId?: string, attempt?: number}} [opts]
   * @returns {Promise<Array<{ok: boolean, id?: string|number, error?: {code: string, message: string, retryable: boolean}}>>}
   */
  async writeRecords(records, opts) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError(this.constructor.name + ".writeRecords");
  }

  /** Read records back by id (post-migration verification). @returns {Promise<object[]>} */
  async readRecords(ids) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError(this.constructor.name + ".readRecords");
  }

  /**
   * Find an existing requester (e.g. created by an earlier migration) by email.
   * Default: not supported. @returns {Promise<{employee_id: string, name?: string}|null>}
   */
  async findRequesterByEmail(email) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Count records written by a run, optionally per workspace. @returns {Promise<number|null>} */
  async countRecords(filter) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError(this.constructor.name + ".countRecords");
  }
}

module.exports = { TargetAdapter };
