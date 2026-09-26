/* HTTP routes for the Customers → Employees migration (mounted by ../api.js).
     GET    /api/customer-migrations/config
     GET    /api/customer-migrations               list (also starts due scheduled runs)
     POST   /api/customer-migrations               {project_id, customer_count?, scheduled_at?}
     GET    /api/customer-migrations/:id
     POST   /api/customer-migrations/:id/advance
     POST   /api/customer-migrations/:id/retry-failed
     POST   /api/customer-migrations/demo-reset    demo only: clear simulated JSM/Freshservice + state
   Credentials never leave the server; responses contain only migration state. */

const { MigrationRequestError } = require("./engine");

function listView(run) {
  const { records, events, ...rest } = run; // eslint-disable-line no-unused-vars
  return { ...rest, failed_records: records.filter((r) => r.status === "FAILED").slice(0, 20) };
}

function createCustomerMigrationRoutes({ engine, store, mappings, jsm, freshservice }) {
  return async function handle(req, res, parts) {
    const [, id, action] = parts;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    try {
      if (id === "config" && req.method === "GET") {
        res.json(await engine.config());
        return;
      }
      if (id === "demo-reset" && req.method === "POST") {
        const j = jsm();
        const f = freshservice();
        if (j.mode !== "mock" || f.mode !== "mock") throw new MigrationRequestError(409, "Reset is only available in demo mode");
        res.json({ jsm_customers: await j.reset(), employees: await f.reset(), migrations: await store.clear(), mappings: await mappings.clear() });
        return;
      }
      if (!id && req.method === "GET") {
        await engine.startDue(new Date());
        res.json({ migrations: (await store.list()).map(listView) });
        return;
      }
      if (!id && req.method === "POST") {
        const run = await engine.create({ projectId: body.project_id, customerCount: body.customer_count, scheduledAt: body.scheduled_at || null, by: body.by || "admin" });
        res.json({ migration: run });
        return;
      }
      if (id && !action && req.method === "GET") {
        const run = await store.get(id);
        if (!run) throw new MigrationRequestError(404, "Migration not found");
        res.json({ migration: run });
        return;
      }
      if (id && action === "advance" && req.method === "POST") {
        res.json({ migration: await engine.advance(id) });
        return;
      }
      if (id && action === "retry-failed" && req.method === "POST") {
        res.json({ migration: await engine.retryFailed(id, { by: body.by || "admin" }) });
        return;
      }
      throw new MigrationRequestError(404, "Unknown route");
    } catch (err) {
      if (err instanceof MigrationRequestError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
}

module.exports = { createCustomerMigrationRoutes };
