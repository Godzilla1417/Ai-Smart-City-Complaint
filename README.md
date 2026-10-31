# CivicFlow

CivicFlow is a responsive single-page complaint workflow built with semantic HTML, custom CSS and vanilla JavaScript. On Vercel, complaint data is stored in Supabase Postgres through server-side Vercel Functions. Local development keeps using browser `localStorage` unless the app is run with Vercel Functions.

## Run locally

1. Open this folder in a terminal.
2. Start a small static web server. For example, with Python installed:

   ```powershell
   py -m http.server 8000
   ```

   Or, with Node/npm installed:

   ```powershell
   npm.cmd run dev
   ```

3. Open `http://localhost:8000` (or the URL printed by `serve`). Use a local server for browser geolocation; browsers generally restrict that feature to secure contexts such as `localhost`.

The page loads Font Awesome, Google Fonts, Chart.js and Leaflet from CDNs, so those assets and the maps need an internet connection. Maps use Leaflet and OpenStreetMap by default; no Google Maps key or billing setup is needed unless you opt in below.

## Interactive maps without a Google API key

Open **Submit a complaint** to search an address, click the map or drag its pin, or use **Use My Current Location**. CivicFlow uses the public OpenStreetMap tile and Nominatim geocoding services. The browser queues geocoding requests at least 1.1 seconds apart to stay within Nominatim's one-request-per-second limit.

OpenStreetMap data is free, and the map displays the required attribution. The community tile and geocoding servers are capacity-limited best-effort services, not unlimited production hosting; follow the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/). For a high-traffic deployment, use a suitable OSM-based provider or host the services yourself.

### Optional: switch the complaint picker to Google Maps

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Maps JavaScript API** and **Geocoding API**.
2. Create an API key. Restrict it to these APIs and to website referrers such as `http://localhost:8000/*`; add your production site referrer if you deploy.
3. In `maps-config.js`, set `CIVICFLOW_MAP_PROVIDER` to `'google'` and paste the key into `CIVICFLOW_MAPS_API_KEY`.
4. Refresh the app and open **Submit a complaint**. Google Maps will handle the interactive picker and address lookup; other maps continue to use OpenStreetMap.

Google Maps requires a key and billing for a standard project, and usage can incur charges. Google also offers a no-cost Maps Demo Key for prototyping select features. Check the current [setup guide](https://developers.google.com/maps/documentation/javascript/get-api-key) and [pricing](https://developers.google.com/maps/billing-and-pricing/pricing) before enabling it. API restrictions and quotas help limit use; budget alerts notify you but do not automatically stop charges ([Google Cloud budget guidance](https://cloud.google.com/billing/docs/how-to/budgets)).

## Demo flows

- Submit a report as a guest and save the generated `CF-############` tracking number. Use Track complaint to inspect its progress.
- Choose the account button to open the resident dashboard. Guest reports appear there in the same browser.
- Open `http://localhost:8000/admin` or choose Admin. The local demo has no server authentication; on Vercel, the key is checked by the server using the `ADMIN_ACCESS_KEY` environment variable.
- To sign in as a resident, choose the account button, select **Create account**, and register with your name, email, and a password of at least six characters. A 10-digit phone number is optional. Later, use the same email and password to sign in. Accounts are stored in this browser for the local demo.
- Use address search, click/drag the map pin, or choose **Use My Current Location**. Location permission denial and unavailable-location errors have inline messages. Typing an address manually is also supported.

## Connect shared complaint storage

1. Create a Supabase project and open **SQL Editor**.
2. Run the SQL in [`supabase/schema.sql`](supabase/schema.sql) to create the complaints table with row-level security enabled.
3. In Supabase, copy the project URL and create a server-side **Secret key**.
4. In Vercel, open the project’s **Settings → Environment Variables** and add these for Production and Preview:
   - `SUPABASE_URL` — the Supabase project URL
   - `SUPABASE_SECRET_KEY` — the Supabase secret key (or legacy service role key)
   - `ADMIN_ACCESS_KEY` — the private admin key you choose
5. Redeploy Vercel after adding the variables.

### Complaint photo uploads

The complaint form accepts an optional JPEG, PNG, or WebP photo. The browser resizes the image and converts it to JPEG before upload (maximum 1.5 MB after compression; files over 15 MB are rejected). On Vercel, photos are stored in the private `civic-complaint-images` Supabase Storage bucket. Staff receive short-lived signed links. Residents receive private evidence links only when their browser presents the random report access key issued at submission.

The `supabase/schema.sql` setup creates the private bucket, restricts its file size and allowed MIME types, and adds the nullable `image_path` column to `public.complaints`. If the complaints table already exists, run the updated schema in Supabase **SQL Editor** once to add the image column and bucket. Keep `SUPABASE_SECRET_KEY` (or the legacy service role key) in Vercel server-side environment variables only. After setup, redeploy the Vercel project and submit a report with an image to confirm uploads are working.

Local development without the shared API can still submit text reports using browser storage, but it cannot persist complaint photos. Use the deployed Vercel app with valid Supabase environment variables to test photo storage.

### Automated priority triage

New reports receive a transparent rule-based recommendation using the complaint text, category and stated location context. It assigns Critical, High, Medium or Low, explains the text that influenced the result, suggests a department and response target, and reports a confidence indicator. It does not infer an affected population unless the report states one. This version does not use a third-party AI model and does not interpret image pixels; treat the recommendation as a triage aid and let authorized staff adjust it. Priority changes preserve the original recommendation and add an audit event.

In the admin queue, use the priority, category, department and status filters, change a report's priority from its row, or sort highest-first. The resident tracking view and dashboard show the recommendation and explanation; private administrator identity and audit data stay in the admin portal.

### Admin proof of resolution and evidence management

In the admin portal, move a repaired report to **Awaiting Resolution Evidence**, open its details, and submit one to four after-repair photos with a description, completion time, and repair team. Images are resized in the browser, then checked again for actual image format and size by the server. Submission sets the complaint to **Pending Verification**; only the separate **Verify and resolve** action changes it to **Resolved**. A reviewer can return evidence with a note, and the admin audit trail retains each action.

Residents can track report status using its report ID. Verified proof is shown using short-lived signed links from the private bucket, with an interactive before/after slider when the original report included a photo. A category-themed reveal uses only the submitted photos. The report's random access key is saved in that browser so only its owner can view photos or request review of a citizen-submitted photo. If the key is cleared or a resident moves to another browser, private evidence access cannot be recovered through the current local-only account system.

Resolution photos are kept in a separate evidence ledger from citizen-submitted photos. Admins can add resolution photos and correct one using **Replace** with a required reason. Replacement retains the previous image and audit entry, then sends the report back to **Pending Verification**. There is no API delete operation for resolution evidence. A citizen can request review of their own submitted photo after a confirmation prompt; the request is audited, the file stays attached while reviewed, and admins can retain it or escalate it for an authorized privacy review. The app does not permanently delete evidence automatically. Define and follow the city's retention policy before deciding that an image should be removed.

The tracking view displays verified updates when residents open or refresh a report; this project has no email or push notification provider configured.

The admin portal uses one shared access key. Unless `ADMIN_ACTOR_ID` is configured, audit entries identify the actor as `shared-admin`; the shared key cannot distinguish individual staff members. The project also has no separate verifier role, so any authorized admin session can submit and verify evidence.

Never put the Supabase secret/service role key in `app.js`, `maps-config.js`, or another browser-visible file. The API routes in `api/` use it only on the server. The submitted report ID provides status lookup; the separate random access key gates private evidence. Only callers with the admin key can list all complaints or update their status, department and priority.

Run `npm test` to run the API and priority workflow tests before deploying. After modifying `supabase/schema.sql`, execute the full script in Supabase SQL Editor, then deploy the updated Vercel branch.

Supabase's Free plan currently includes a 500 MB database and can pause projects after a week of inactivity; review [current plan limits](https://supabase.com/pricing). The local server still uses browser storage, while Vercel-hosted pages use the shared database API.
