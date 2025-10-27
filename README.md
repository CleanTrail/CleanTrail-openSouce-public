# 🧹 CleanTrail

**CleanTrail** is a lightweight privacy extension for Chrome that helps you see and stop what’s tracking you online.

It automatically blocks trackers (including many ad networks), cleans up cookies and cache, and even detects fingerprinting scripts — all while giving you a clear privacy score for each browsing session.

> 🛡️ This repository contains the **free-tier, open-source version** of CleanTrail.  
> Premium features (Pro & Pro+) are part of the private production build and are **not included** here.

---

## ✨ Features (Free Tier)

- **3 Privacy Profiles** — Strict, Balanced, and Relaxed modes  
- **Adaptive Profiles** — Auto-switches based on trust level or domain type (e.g. `.onion` → Paranoid)  
- **Trusted Site Whitelisting** — Skip cleanup or blocking on safe domains  
- **Real-Time Tracker Blocking** — Uses a bundled community list  
- **Privacy Score Meter (A–D)** — Quickly see your browsing hygiene  
- **Manual Cleanup** — Instantly delete cookies and cache from all sites  
- **Optional Auto Cookie Cleanup** — Removes non-essential cookies automatically  
- **Fingerprinting Detection** — Detects common JS-based fingerprinting attempts  
- **Simple Privacy Analytics** — View pending and blocked trackers, cookies, and cache data

---

## 🧠 How It Works

CleanTrail operates locally within your browser.  
No data is sent externally — all blocking and cleanup are performed via Chrome’s built-in APIs and declarativeNetRequest (DNR) rules.

### Background Logic Includes:
- Profile handling (`strict`, `balanced`, `relaxed`)  
- Adaptive privacy switching  
- Local rule generation from `bundled-rules.json`  
- Cookie category detection using `bundled-cookie-categories.json`  
- Badge updates reflecting your current privacy score  

### Content Scripts:
- `content-fingerprint.js` — Detects fingerprinting attempts  
- `content-cleanup.js` — Removes site data on tab close   

---

## 🧩 Project Structure


---

## 🧰 Permissions Used

| Permission | Purpose |
|-------------|----------|
| `cookies` | Manage and remove cookies |
| `browsingData` | Clear cache and site data |
| `storage` | Store settings and stats |
| `tabs` | Track per-tab domain for cleanup |
| `scripting` | Inject cleanup and detection scripts |
| `declarativeNetRequest` | Block known tracker domains |

---

## ⚙️ How to Load in Chrome (Developer Mode)

1. Clone or download this repository  
2. Open **chrome://extensions** in your browser  
3. Enable **Developer mode** (top right toggle)  
4. Click **Load unpacked**  
5. Select the folder containing this repo  
6. The CleanTrail icon will appear in your toolbar

---

## 🔒 About This Build

This public release includes only **free-tier functionality** for transparency and educational use.

Features like:
- Session hijacking detection  
- Dark pattern detection  
- Scheduled cleanups  
- Encrypted sync  
- Phishing protection  
- Advanced fingerprint spoofing  
are exclusive to **CleanTrail Pro** and **Pro+**, and implemented in a separate private codebase.

---

## 🧾 License

This project is open-source under the **MIT License**.  
You’re free to inspect, fork, or adapt the code for educational or personal use — but please credit CleanTrail if you use it in derivative projects.

---

## 🌐 Official Links

- **Website:** [https://www.cleantrail.net](https://www.cleantrail.net)  
- **Chrome Web Store:** [https://chromewebstore.google.com/detail/cleantrail/jndmenkfpnihhjlnobgpifocfkleoeon]  
- **Email:** support@cleantrail.net 

---

### 🔐 Important Notice

This open-source repository only covers the **free-tier** portion of CleanTrail.

The **full CleanTrail extension**, including Pro and Pro+ features, is governed by its own  
**Terms of Service** and **Privacy Policy**, available at:

- [https://cleantrail.net/terms](https://cleantrail.net/terms)  
- [https://cleantrail.io/privacy](https://cleantrail.net/privacy)

These govern all usage, data handling, and feature access of the commercial version.


> Built with ❤️ by the CleanTrail Team  
> “Privacy should be visible — not silent.”
