<div align="center">

# GeoGuide

**Community-driven Interactive Geographic Atlas & Street View Meta Knowledge Base**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-orange.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Vercel-black.svg)](https://vercel.com)
[![Database](https://img.shields.io/badge/Database-Turso%20LibSQL-00ED64.svg)](https://turso.tech)

[**English**](README.md) | [**简体中文**](README_zh.md)

</div>

---

## Overview

**GeoGuide** is an open-source, interactive web atlas designed for **GeoGuessr competitive players, street view navigators, and geography enthusiasts**.

Traditional GeoGuessr study materials rely on static, 100-page Google Docs and low-resolution screenshots. When a guide says *"red soil in northern regions"*, players cannot accurately tell where the boundary starts or how daylight affects identification.

**GeoGuide solves this by bridging the gap between text and coordinates:**
- Every geographic clue (*Meta*) is drawn as an interactive **Polygon boundary** or **Polyline highway**.
- Clicking a region instantly launches a **split-screen interactive 360° Google Street View**, pre-configured with the author's recommended camera heading, pitch, and field of view.

---

## Key Features

- **Interactive Macro World Map & Heatmap**
  - Real-time global coverage heatmap showing region counts across documented countries.
  - Hover highlights with linked territorial relationships (e.g. Taiwan, Hong Kong, Macau integrated with China).
- **High-Precision Vector Boundaries**
  - **Polygons**: Golden-ratio color palette defining biomes, administrative divisions, and soil transitions.
  - **Polylines**: Highway and road infrastructure meta (bollards, dashed lines, guardrails).
  - **Dot Collapse**: Automatically collapses dense clusters into responsive pins at low zoom levels.
- **360° Street View with Historical Captures**
  - Embedded Google Street View iframe supporting specific `pano` capture IDs (historical coverage).
  - Zero Google Maps JavaScript API quota burn on Street View navigation.
- **Graceful Zero-Key Out-of-the-Box Experience**
  - Works **100% out of the box** on OpenStreetMap (CartoDB tiles) without any API key required.
  - If no Google Maps API key is configured, map browsing remains completely functional, with clear prompts to add an optional key for street view.
- **Community Contribution & Review System**
  - In-browser polygon/line editing and **KML / GeoJSON import**.
  - Review queue for community moderation (Approved, Changes Requested, Rejected).
  - Community reaction system (GOAT, Love, Helpful) and dynamic **Contributor Constellation** leaderboard.
- **Study Toolkit & Deep Linking**
  - **Favorites Toolbar**: Sort by newest/oldest, filter by country with badge counts, and search by keyword.
  - **Compare Mode**: Side-by-side comparison of two easily confused road segments or regions.
  - **Instant Share Links**: Direct URLs (`/explore?country=...&region=...`) for instant post-game team debriefs.
  - **Theme System**: Full WCAG-compliant Dark and Light mode switcher.

---

## Architecture & Tech Stack

GeoGuide is intentionally built with a lightweight, ultra-fast tech stack free of heavy frontend frameworks:

- **Frontend**: Vanilla JavaScript (ES6+), [Leaflet.js](https://leafletjs.com/), [Geoman](https://geoman.io/) for geometry drawing, CSS3 Custom Properties.
- **Backend**: Node.js Serverless Functions deployed on [Vercel](https://vercel.com/).
- **Database**: [Turso](https://turso.tech/) (Distributed Edge LibSQL / SQLite).
- **Authentication**: Discord OAuth2 (optional for public logins).
- **AI Translation**: DeepSeek API (for one-click translation of multilingual notes).

---

## Quick Start & Local Setup

### 1. Minimal Static Preview (No API Key Required)

If you only want to explore the UI and map layers, you can run the static site immediately:

```bash
# Clone the repository
git clone https://github.com/LuanJiangXing/geoguide.git
cd geoguide

# Serve the public directory with any static server
npx serve public
# or
python3 -m http.server 8080 --directory public
```

Open `http://localhost:8080` in your browser. All OpenStreetMap base layers and client-side interactions will work immediately.

---

### 2. Full Local Development (With Backend & Street View)

To enable user submissions, backend APIs, and Street View embedding:

#### Step 1: Install Dependencies
```bash
npm install
```

#### Step 2: Configure Environment Variables
Copy the template configuration file:
```bash
cp .env.example .env.local
```

Open `.env.local` and configure your credentials:
```bash
# Google Maps (Optional, for Street View embed)
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

# Turso Database (Optional, for submissions and review portal)
TURSO_URL=libsql://your-database-name.turso.io
TURSO_TOKEN=your_turso_auth_token_here

# Admin Password (for /review.html queue)
admin_password=your_secure_password
```

> **Note**: For Google Maps, enable **Maps Embed API** and **Maps JavaScript API** in [Google Cloud Console](https://console.cloud.google.com/).

#### Step 3: Build & Run
```bash
# Generate public/js/config.js with build secrets
npm run build

# Run local development with Vercel CLI (or static server)
npx vercel dev
```

---

## Contributing

Contributions from the global geography and GeoGuessr community are welcome!
- **Bug reports & Feature requests**: Please open an [Issue](https://github.com/LuanJiangXing/geoguide/issues).
- **Code & Map Data**: Feel free to submit a [Pull Request](https://github.com/LuanJiangXing/geoguide/pulls).

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)](LICENSE) license.

> **Commercial use is strictly prohibited.** You are free to share and adapt the material for non-commercial purposes only, provided appropriate credit is given and derivative works are released under the same license.
