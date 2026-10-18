# Atlas — Accounting app

This is the **Accounting** department of Atlas as its own web app. Same logo,
theme and login as Atlas; it contains only the Accounting pages.

| | |
|---|---|
| This app | http://localhost:5174 |
| Atlas backend (shared) | http://localhost:4000 |
| Warehouse app | http://localhost:5173 |
| Vendors app | http://localhost:5175 |

## How the apps fit together

Every department app is a separate frontend, and they all talk to **one Atlas
backend and one database**. That is what keeps them integrated: a figure that two
departments need (for example stock value in Warehouse and Accounting) is computed
once by the backend and shown identically in both apps, and you sign in once.
Each project folder contains the full backend, identical in all of them — you only
ever run **one** backend, from any one of the project folders.

## Run it (Windows)

Requires Node.js 22 or newer.

1. Double-click `start-backend.cmd` (only once, from any department project).
   Leave the window open.
2. Double-click `start-app.cmd` in this folder. Leave it open.
3. Open http://localhost:5174

Mac/Linux: run `./start-backend.sh` and `./start-app.sh` instead.

To use several departments at once, start each department's `start-app.cmd`
(each has its own port). Opening a department's link from another app's
"shared with" label or the Atlas sidebar group switches apps.

## First time only: create the company

A fresh database has no company or user. In PowerShell, with the backend running:

```powershell
$body = @{
  companyName = "Karam Foods"
  adminName = "Hamada"
  adminContact = "you@example.com"
  adminPassword = "Something1234!"
  currency = "USD"
  acceptedPrivacyPolicy = $true
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:4000/api/companies" -Method Post -ContentType "application/json" -Body $body
```

Then, from the `backend` folder, skip the setup wizard:

```powershell
node -e "require('./db/init').prepare('UPDATE companies SET setup_completed=1 WHERE id=1').run()"
```

Log in with that email and password. Give each person only the permissions of their
department in Settings → Permissions: the dashboards follow the permissions, so a
user without Accounting permissions cannot open the Accounting dashboard even if
they reach its address.

## PDF export (statements, aging, reports) needs Chromium

PDF files are rendered by a headless Chromium through Playwright
(`backend/lib/pdfExport.js`). Excel exports do not need it. Without a browser
the PDF request answers `pdf_export_failed`.

**Option A — let Playwright download its own Chromium (recommended).**
In PowerShell, from the `backend` folder (once, needs internet):

```powershell
cd backend
npx playwright install chromium
```

It is stored under `%LOCALAPPDATA%\ms-playwright` and found automatically.
Restart `start-backend.cmd` afterwards.

**Option B — use Chrome or Edge that is already installed.** Point
`PLAYWRIGHT_CHROMIUM_PATH` at the browser executable before starting the
backend:

```powershell
# this window only
$env:PLAYWRIGHT_CHROMIUM_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
# or Edge:
# $env:PLAYWRIGHT_CHROMIUM_PATH = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# permanently for your Windows user (open a NEW window afterwards)
setx PLAYWRIGHT_CHROMIUM_PATH "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Then start the backend again (`start-backend.cmd` picks the variable up from
the environment). Mac/Linux: `export PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`
before `./start-backend.sh`.

Check: open any customer in Customer Ledger and click **PDF** on the statement
bar — a file with Arabic text should download.

## Notes

- The database is `backend/db/data.sqlite`, created on first start. Back it up.
- Figures shared with other departments are marked "Shared with …" on the dashboard.
- If a port is busy the app refuses to start rather than hopping to another port
  (the apps link to each other by port). Change `VITE_PORT` in `frontend/.env`.
- Other apps:
- Warehouse: http://localhost:5173
- Vendors: http://localhost:5175
