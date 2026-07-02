# TODO - Reorganize routes into /routes

## Plan steps

- [ ] Create `routes/` directory structure: `routes/admin`, `routes/customer`, `routes/inquery`, `routes/products`, `routes/categories`.
- [ ] Move route handler files from `api/**` into the matching `routes/**` subfolders.
- [ ] Update moved route handler files’ `require(...)` paths if needed (relative imports like `../../config/prisma`, `../../middleware/...`, `../../utils/...`).
- [ ] Update `app.js` to import route handlers from `./routes/...` instead of `./api/...`.
- [ ] Smoke-check endpoint mounts remain unchanged in `app.js`.
- [x] Remove/cleanup old `api/` route folders/files after verifying no imports remain.

- [x] Run `npm run lint` (if available) and/or `node server.js` to ensure the server starts.
