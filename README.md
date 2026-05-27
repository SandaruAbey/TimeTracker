# TimeTracker Chrome Extension

A premium, serverless Chrome Extension (Manifest V3) to track work time per task and sync data directly with your company's Google Sheet in real-time. No database or external servers required!

---

## Features

- **OAuth 2.0 Sign-In**: Securely logs into your Google Workspace account directly through Chrome.
- **Dynamic Task Dashboard**: Auto-loads task lists from sheet tabs, pre-filters to show only your tasks, and parses data-validation statuses (Morning/Evening Statuses).
- **Precision Floating Bottom Toolbar**: Injected into your active browser tabs via an isolated Shadow DOM. Features:
  - Live ticking timer showing `HH:MM:SS`.
  - Pause / Resume controls.
  - Interactive "Submit Time" button that adds your tracked time directly to the sheet.
  - Mutual exclusion (starting Task B auto-pauses Task A).
- **Cumulative Updates**: Tracks and adds time cumulatively (e.g. if the sheet row has `45` mins, adding `15` mins updates it to `60` mins).
- **Glassmorphism Theme**: High-fidelity dark mode matching modern dashboard aesthetics.

---

## 🛠️ Step-by-Step Setup Guide

To install and run the extension, you need to link it to a Google Cloud project to enable OAuth and Google Sheets API access. Follow these steps:

### Phase 1: Google Cloud Console Setup

1. **Create a Google Cloud Project**:
   - Go to the [Google Cloud Console](https://console.cloud.google.com/).
   - Click the project dropdown in the top-left and select **New Project**. Name it `TimeTracker` and click **Create**.

2. **Enable Google Sheets API**:
   - In the sidebar, navigate to **APIs & Services** > **Library**.
   - Search for **Google Sheets API**.
   - Select it and click **Enable**.

3. **Configure OAuth Consent Screen**:
   - Go to **APIs & Services** > **OAuth consent screen**.
   - Select **User Type** as **Internal** (if using a Google Workspace account) or **External** (if using a standard @gmail.com account), then click **Create**.
   - Fill in the required fields:
     - **App name**: `TimeTracker`
     - **User support email**: Your email address
     - **Developer contact information**: Your email address
   - Click **Save and Continue**.
   - **Scopes**: Click **Add or Remove Scopes**. In the manually add box, paste:
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/userinfo.email`
   - Click **Add to table**, check them, and click **Update**.
   - Click **Save and Continue** until finished.

---

### Phase 2: Load Extension in Chrome

1. Open Google Chrome and go to `chrome://extensions/`.
2. Toggle the **Developer mode** switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the project folder: `c:\AI\TimeTracker`.
5. The extension will load. Look at the extension card and copy its **ID** (a 32-letter random string, e.g., `nkflhfgckcclldpjigepnhphdbmdhmpd`).

---

### Phase 3: Create OAuth Client Credentials

1. Go back to the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **APIs & Services** > **Credentials**.
3. Click **+ CREATE CREDENTIALS** and select **OAuth client ID**.
4. In the **Application type** dropdown, select **Chrome extension**.
5. Fill in the fields:
   - **Name**: `TimeTracker Extension`
   - **Item ID**: Paste the **ID** you copied from `chrome://extensions/` in Phase 2.
6. Click **Create**. A dialog will appear with your Client ID.
7. Copy the Client ID.

---

### Phase 4: Configure the Extension Code

1. Open [manifest.json](file:///c:/AI/TimeTracker/manifest.json) in your code editor.
2. Locate the `"oauth2"` section:
   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     "scopes": [ ... ]
   }
   ```
3. Replace `"YOUR_CLIENT_ID.apps.googleusercontent.com"` with the Client ID you copied in Phase 3.
4. Save the file.
5. In Chrome, go back to `chrome://extensions/` and click the **Refresh (circular arrow)** icon on the TimeTracker card. This reloads the extension with the correct OAuth configuration.

---

## 🚀 How to Use

1. Click the **Extensions puzzle piece** icon in Chrome and click **TimeTracker** (you can pin it for easy access).
2. Click **Sign in with Google**. A popup will appear. Grant permissions to the extension to access your Google Sheets.
3. **Connect your Sheet**:
   - Paste the full URL of your task sheet. (The header row should be row 1, and your data columns should align with the structure below).
   - Click **Connect Sheet**.
4. **Choose your name**: Select your name from the dropdown. This is pulled automatically from column C (**Name**) of the sheet.
5. **Select Sheet Tab (Date)**:
   - The extension will list all sheets/tabs in the file.
   - Tabs named with the current date (e.g. `2026-05-26`) will automatically have a **Today** indicator.
   - Select the sheet tab to open.
6. **Task Board**:
   - You will see a list of tasks assigned to your name.
   - Click on any task card to go to the **Task Detail** page.
7. **Tracking Time**:
   - Inside the Task Detail page, click **Start Timer**.
   - A pulsing banner will show at the bottom of the popup, and a floating toolbar will slide up at the bottom of *any* web page you visit.
   - You can **Pause / Resume** from either the popup or the webpage toolbar.
   - Click **Submit Time** (on the webpage toolbar) or **Add** (in the popup) to add the elapsed time (converted to minutes) to your today's spent cell on Google Sheets.
   - You can edit your **Morning Status** and **Evening Status** from the detail page and click **Save Status** to update the sheet.

---

## 📊 Google Sheet Column Layout (Expected)

The extension maps columns as follows (0-indexed):

| Column | Header | Description |
|---|---|---|
| **A (0)** | Project Code | e.g. `PROJ-A` |
| **B (1)** | Task Automation Code | Identifier |
| **C (2)** | Name | Employee Name (used to filter) |
| **D (3)** | Task Type | e.g. `Development`, `UI Design` |
| **E (4)** | Jira # / Title | Main task description |
| **F (5)** | URL | Optional link |
| **G (6)** | Priority | e.g. `High`, `Medium`, `Low` |
| **H (7)** | Morning Status | Selectable status |
| **I (8)** | Evening Status | Selectable status |
| **J (9)** | Target Date | Target completion date |
| **K (10)** | Date Start | Project start date |
| **L (11)** | Allocated Time | Planned duration |
| **M (12)** | Today's Spent (mins) | Cell updated when clicking **Submit** |
| **N (13)** | Total (mins) | Cumulative total |
| **O (14)** | Total Week | Weekly calculation |
| **P (15)** | Extra Mins? | Buffer time |

*If your sheet starts with a different order, you can customize the mappings in [background.js](file:///c:/AI/TimeTracker/background.js) (`const COL = { ... }`) and [popup/popup.js](file:///c:/AI/TimeTracker/popup/popup.js) (`const C = { ... }`).*

---

## Troubleshooting

- **OAuth error (Invalid client or redirect URI)**: Double check that the ID in `chrome://extensions/` matches the Item ID you entered when creating the credential in the Google Cloud Console, and that you updated the `client_id` in `manifest.json` and refreshed the extension.
- **Fail to Sign In Error on other PCs / ID Change**:
  To ensure the extension ID remains `gjbolcmennlebbheomdjbcnglefcljng` across different PCs (which is required by the registered Google OAuth Client ID):
  1. **Consistent Absolute Path**: Load the unpacked extension on other PCs from exactly the same absolute path: `c:\AI\TimeTracker`. Because Chrome hashes the absolute folder path to generate the ID for unpacked extensions, keeping the path identical ensures the ID stays `gjbolcmennlebbheomdjbcnglefcljng`.
  2. **Using a `"key"` in `manifest.json`**:
     If you package the extension (using the "Pack extension" button in `chrome://extensions`), Chrome generates a private `.pem` key file. You can extract the public key string from this file and add a `"key": "<public_key_string>"` field to `manifest.json`. When the `"key"` property is present in the manifest, Chrome will always load the extension with that exact same ID `gjbolcmennlebbheomdjbcnglefcljng` regardless of the folder path.
- **Permissions / CORS**: The background service worker has permission to access `https://sheets.googleapis.com/*`. Make sure you're connected to the internet and logged in with an account that has edit permissions to the Google Sheet URL you pasted.
- **Floating Toolbar doesn't appear**: The toolbar will slide up when you visit websites with standard DOM. It may not appear on internal browser pages (like `chrome://` or Chrome Web Store pages) due to browser security restrictions. Try visiting any public webpage (e.g. `google.com`, `wikipedia.org`).
