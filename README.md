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

The complaint form accepts an optional JPEG, PNG, or WebP photo. The browser resizes the image and converts it to JPEG before upload (maximum 1.5 MB after compression; files over 15 MB are rejected). On Vercel, photos are stored in the private `civic-complaint-images` Supabase Storage bucket. Only authorized staff see a temporary **View photo** link in the admin report queue; public tracking responses do not include photo links.

The `supabase/schema.sql` setup creates the private bucket, restricts its file size and allowed MIME types, and adds the nullable `image_path` column to `public.complaints`. If the complaints table already exists, run the updated schema in Supabase **SQL Editor** once to add the image column and bucket. Keep `SUPABASE_SECRET_KEY` (or the legacy service role key) in Vercel server-side environment variables only. After setup, redeploy the Vercel project and submit a report with an image to confirm uploads are working.

Local development without the shared API can still submit text reports using browser storage, but it cannot persist complaint photos. Use the deployed Vercel app with valid Supabase environment variables to test photo storage.

Never put the Supabase secret/service role key in `app.js`, `maps-config.js`, or another browser-visible file. The API routes in `api/` use it only on the server. Public users can submit a complaint and look up an individual report by its tracking ID; only callers with the admin key can list all complaints or update their status and department.

Supabase's Free plan currently includes a 500 MB database and can pause projects after a week of inactivity; review [current plan limits](https://supabase.com/pricing). The local server still uses browser storage, while Vercel-hosted pages use the shared database API.
