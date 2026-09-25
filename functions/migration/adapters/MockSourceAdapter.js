/* MockSourceAdapter — serves generated demo records in the dialect of a
   given source profile (jira, legacy-itsm, mock-legacy). */

const { SourceAdapter } = require("./SourceAdapter");
const { ZEN_RECORD_FIELDS } = require("../schema");
const { generateDemoRecords, nativeSchema, toNativeRecord } = require("../demoData");

class MockSourceAdapter extends SourceAdapter {
  /**
   * @param {object} meta     see SourceAdapter
   * @param {object} opts
   * @param {string} opts.profile  demo data dialect
   * @param {number} [opts.count]  number of records to generate
   * @param {number} [opts.seed]   PRNG seed
   * @param {"realistic"|"clean"} [opts.quality]  realistic includes data-quality issues
   */
  constructor(meta, { profile, count = 750, seed = 42, quality = "realistic" } = {}) {
    super({ ...meta, mode: "mock" });
    this.profile = profile;
    this.count = count;
    this.seed = seed;
    this.quality = quality;
    this._records = null;
  }

  records() {
    if (!this._records) {
      this._records = generateDemoRecords({ profile: this.profile, count: this.count, seed: this.seed, quality: this.quality });
    }
    return this._records;
  }

  async testConnection() {
    return { ok: true, message: "Demo mode — " + this.count + " generated records available." };
  }

  async getSchema() {
    return ZEN_RECORD_FIELDS;
  }

  async countRecords() {
    return this.count;
  }

  async getRawSchema() {
    return nativeSchema(this.profile);
  }

  async fetchRawRecords(opts = {}) {
    const page = await this.fetchRecords(opts);
    const start = opts.cursor ? parseInt(opts.cursor, 10) || 0 : 0;
    return {
      records: page.records.map((r, i) => toNativeRecord(this.profile, r, start + i)),
      nextCursor: page.nextCursor,
    };
  }

  async fetchRecords({ cursor = null, limit = 50 } = {}) {
    const all = this.records();
    const start = cursor ? parseInt(cursor, 10) || 0 : 0;
    const end = Math.min(start + limit, all.length);
    return {
      records: all.slice(start, end),
      nextCursor: end < all.length ? String(end) : null,
    };
  }
}

module.exports = { MockSourceAdapter };
