# CivicFlow

CivicFlow is a responsive single-page frontend demo for a smart city complaint workflow. It uses semantic HTML, custom CSS and a vanilla JavaScript state engine. In this checked-out project, there are currently no Python/FastAPI files, PostgreSQL models, environment files, or API routes; complaint and citizen records are stored in `localStorage` until a backend contract is available.

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

The page loads Font Awesome, Google Fonts, Chart.js and Leaflet from CDNs, so those assets and the maps need an internet connection. Maps use Leaflet and OpenStreetMap by default; no Google Maps key or billing setup is needed unless you opt in below. The core complaint workflow and local data storage run in the browser.

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

- Submit a report as a guest and save the generated `CF-######` tracking number. Use Track complaint to inspect its progress.
- Choose the account button to open the resident dashboard. Guest reports appear there in the same browser.
- Open `http://localhost:8000/admin` or choose Live dashboard, then enter the admin key `Kube_vertex` to access operations.
- To sign in as a resident, choose the account button, select **Create account**, and register with your name, email, and a password of at least six characters. A 10-digit phone number is optional. Later, use the same email and password to sign in. Accounts are stored in this browser for the local demo.
- Use address search, click/drag the map pin, or choose **Use My Current Location**. Location permission denial and unavailable-location errors have inline messages. Typing an address manually is also supported.

## Data model

The browser store contains three JSON collections/objects:

- `civicflow.users.v1`: `{ id, fullName, email, phone, passcodeHash, createdAt }`
- `civicflow.complaints.v1`: `{ id, userId, title, description, category, address, location, zone, latitude, longitude, status, department, createdAt }`
- `civicflow.session.v1`: `{ userId }`

These fields are shaped like relational rows to make a future `fetch()` adapter straightforward. Complaint submissions now have a backend-ready JSON shape:

```json
{
  "title": "Large pothole on Oak Street",
  "description": "A large pothole is blocking part of the road.",
  "category": "Roads",
  "latitude": 40.7142,
  "longitude": -74.0064,
  "address": "Oak Street, Northside"
}
```

It is exposed as `window.civicFlowBuildComplaintPayload(formData)`; no `fetch()` call was added because this workspace has no existing endpoint to call. After the FastAPI route and request model are available, call `fetch()` with this object and that confirmed route.

The admin map displays coordinate-bearing local demo reports using status-colored markers. Its data loader is exposed as `window.civicFlowRenderAdminMap(records)` so an existing backend response can be passed in once the API is identified. Marker popups show only complaint ID, category, description, and status; the map does not show citizen name, email, or phone.

The seeded reports render dashboards on first launch. Clear this site's local storage to reset to the original sample data.

This is a hackathon frontend mock, not a production identity or authorization system. Real deployments should move identity, authorization, validation, storage and reporting endpoints behind a server API.
