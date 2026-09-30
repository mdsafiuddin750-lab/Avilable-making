# WhatsApp Auto Reply Bot (Pairing Code)

Baileys based bot. QR nahi, **pairing code** se link hota hai. Sab settings environment variables se.

## Local test
1. `npm install`
2. `.env.example` ko `.env` naam se copy karo aur values badlo
3. `npm start` -> terminal me PAIRING CODE aayega
4. Phone: WhatsApp > Settings > Linked devices > Link a device > **Link with phone number instead** > code daalo

## GitHub
```
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```
`.env` aur `auth/` .gitignore me hain, wo push nahi honge (zaroori hai, warna session leak hoga).

## Render
- New > Web Service > GitHub repo chuno
- Build Command: `npm install`  |  Start Command: `npm start`
- Environment me `.env.example` ke saare variables daalo (PAIRING_NUMBER, ADMIN_KEY zaroori)
- Deploy ke baad `https://APP.onrender.com/pair?key=ADMIN_KEY` kholo, code dikhega, phone me daalo
- **Session bachane ke liye**: Render me Disk add karo (paid plan), mount path `/data`, aur `AUTH_DIR=/data/auth` set karo. Bina disk ke har redeploy/restart par dobara pairing karni padegi.
- Free plan 15 min idle me sleep ho jata hai. UptimeRobot se `/health` ko har 5 min ping karo.

## Railway
- New Project > Deploy from GitHub repo
- Variables me sab env daalo
- Volume add karo, mount path `/data`, `AUTH_DIR=/data/auth`
- Settings > Networking > Generate Domain, phir `/pair?key=ADMIN_KEY` kholo

## Owner commands (apne number se, apne hi chat me)
`!on`, `!off`, `!status`, `!send 919999999999 hello`

## Variables ka matlab
Har variable ka comment `.env.example` me likha hai. Message me `{name}` (sender ka naam) aur `{time}` use kar sakte ho.

## Dhyan rakho
Ye unofficial library hai. Zyada spam/bulk messages par WhatsApp number ban kar sakta hai. Pehle secondary number se test karo, COOLDOWN_MINUTES kam mat rakho.
