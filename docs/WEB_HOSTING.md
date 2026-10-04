# HappyDrive web preview hosting

Public customer/supplier URL: https://happydrive.ayonix.com
API URL: https://happydrive-api.ayonix.com

The existing named Cloudflare tunnel `happydrive-api` now routes the web hostname to `127.0.0.1:13001` and the API hostname to `127.0.0.1:8090`. TLS is terminated at Cloudflare. The DNS record for the web hostname points to that tunnel. Neither process needs an exposed origin port.

Systemd service templates and non-secret environment examples are in `infra/systemd/`. Installed services are `happydrive-web`, `happydrive-api`, `happydrive-worker` and `cloudflared-happydrive-api`. API/worker drop-ins select the release through `/home/ubuntu/happydrive-runtime/current`. Credentials remain in root-readable `/etc/happydrive/api.env` and `/etc/cloudflared/happydrive-api.json`; they are not stored in the repository. `/etc/happydrive/web.env` contains the internal API URL, secure-cookie setting and external evidence origin.

The application is a public preview. Google OAuth clients, actual SMS delivery and production storage/provider configuration remain outstanding. The API retains its existing development adapter configuration and sets `PUBLIC_PREVIEW=true`; request creation is refused independently of those adapters. Checkout is also disabled. This does not permit development adapters in a production/staging API configuration.

Before deployment, the database `happydrive_public` and previous tunnel, environment and systemd files were backed up under `/var/backups/happydrive/20261004-domain`, accessible only to root. Migrations 005–007 were applied additively. Existing accounts and encryption keys were preserved.

## Subsequent deployment

Build and verify a separate release directory, using the same build-time evidence origins and secure-cookie setting. Do not rebuild the `.next` directory of the running release. Install dependencies from the frozen lockfile, verify API and Next production output, then atomically switch the `current` link and restart the API, worker and web services. Check public HTTPS, API health, unauthenticated redirect/CSRF cookies and provider-unconfigured responses. Migration changes require a compatible database rollback plan; restoring an old application version does not automatically revert its database schema or encrypted idempotency records.

Release acceptance and remaining product work are tracked in `docs/V2_DELIVERY_STATUS.md`. Opening the public URL does not establish that customer sign-in, payments, all features or App Store distribution are ready.
