/* SourceAdapter — contract every source system implements.
   Adapters read from their system and return records in the Zen record
   shape (see ../schema.js). The engine never talks to a system directly. */

class NotImplementedError extends Error {
  constructor(what) {
    super(what + " is not implemented");
    this.name = "NotImplementedError";
  }
}

class SourceAdapter {
  /**
   * @param {object} meta
   * @param {string} meta.id          stable id used by the API (e.g. "jira")
   * @param {string} meta.name        display name
   * @param {string} meta.system      logical system the adapter represents
   * @param {"mock"|"live"} meta.mode mock = demo data, live = real API
   * @param {string} [meta.description]
   */
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
      role: "source",
      system: this.system,
      mode: this.mode,
      description: this.description,
    };
  }

  /** @returns {Promise<{ok: boolean, message: string}>} */
  async testConnection() {
    throw new NotImplementedError(this.constructor.name + ".testConnection");
  }

  /** Zen record fields this source can supply. @returns {Promise<Array<{key,label,type}>>} */
  async getSchema() {
    throw new NotImplementedError(this.constructor.name + ".getSchema");
  }

  /** @returns {Promise<number|null>} total records available, null if unknown */
  async countRecords() {
    throw new NotImplementedError(this.constructor.name + ".countRecords");
  }

  /**
   * Read one page of records. The cursor is opaque to callers.
   * @param {{cursor?: string|null, limit?: number}} opts
   * @returns {Promise<{records: object[], nextCursor: string|null}>}
   */
  async fetchRecords(opts) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError(this.constructor.name + ".fetchRecords");
  }

  /**
   * Fields exactly as the source system names them (input to field mapping).
   * Default: the Zen record fields, for sources that only offer normalised data.
   * @returns {Promise<Array<{key: string, label: string}>>}
   */
  async getRawSchema() {
    return (await this.getSchema()).map((f) => ({ key: f.key, label: f.label || f.key }));
  }

  /**
   * One page of records in the source's own field names. Same paging contract
   * as fetchRecords. Default: the normalised records.
   * @returns {Promise<{records: object[], nextCursor: string|null}>}
   */
  async fetchRawRecords(opts) {
    return this.fetchRecords(opts);
  }
}

module.exports = { SourceAdapter, NotImplementedError };
