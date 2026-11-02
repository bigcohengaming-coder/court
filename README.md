# Petty Court

A mock court for petty fights between friends. File a case, share the invite link, and argue it out in **live voice chat**. Bring photo evidence, raise objections, let the jury vote, and get a verdict with a sentence.

## What's in it

- **Live voice courtroom.** Everyone in a case can join voice. The petitioner, defendant and judge can talk. Jurors and the gallery listen, and can raise a hand to ask for the floor.
- **The judge runs the court.** Only the judge can move the hearing to the next phase, bang the gavel (everyone hears it), mute people, and give or take back the floor. The server enforces this, not just the buttons.
- **Order in the court.** The judge's gavel button mutes everyone except the judge, until the judge unmutes them.
- **Scheduled hearings.** The case creator or judge sets a date and time. Everyone sees it in their own time zone, with a countdown, Google Calendar and calendar-file buttons, and an alert when it starts.
- **Role invites.** The case creator or judge makes an invite link for a specific seat (defendant, judge, jury…) with a ready-made message to send on WhatsApp, by email or anywhere else. Whoever opens it can take that seat without waiting for approval.
- **Photo evidence.** The parties and the judge upload screenshots and photos as Exhibit A, B, C. Anyone seated marks them "Credible" or "Sus".
- **Objections and rulings**, a **jury vote** with a live tally, a **punishment wheel**, and a verdict certificate.
- **AI judge (optional).** With an Anthropic API key set, a case can be judged by Claude. It reads the written record and looks at the photos. It can't hear the voice hearing.
- **Practice hearing** to try things out alone.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. To try voice with a second person on your computer, open http://127.0.0.1:3000 in another browser window. It counts as a different person. Microphones only work on `localhost` or on an `https://` site.

## Put it online (free, with Render)

1. **Put the code on GitHub.** Create a new repository at https://github.com/new. On the empty repository page, click **uploading an existing file** and drag in everything in this folder **except** the `node_modules` and `data` folders. Commit.
2. **Create the site on Render.** Sign up at https://render.com, then choose **New → Blueprint** and pick your repository. Render reads `render.yaml` and sets everything up. When it asks for the optional values, leave them blank for now.
3. Wait for the deploy to finish. Your court is live at the `https://…onrender.com` address Render shows you.

### Good to know about the free plan

- The site **sleeps after 15 minutes with no visitors**. The first visit after that takes about a minute to wake up.
- When the site restarts or redeploys, **cases and photos are wiped**. Hearings are usually one evening long, so that's often fine. To keep them, switch the service to a paid plan, add a **Disk** in Render mounted at `/var/data`, and set the environment variable `DATA_DIR` to `/var/data`.

## Optional settings

Set these under your service's **Environment** tab in Render.

| Setting | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on the AI judge. Create a key at https://console.anthropic.com. Each ruling costs a few cents. |
| `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | A TURN relay for voice. Without one, voice can fail for people on some mobile networks or strict office Wi-Fi. Free relays are available from providers such as Metered (https://www.metered.ca/stun-turn). `TURN_URLS` can list several addresses separated by commas. |

## How voice works

Everyone in voice first tries to connect directly to everyone else (WebRTC). The server only passes along connection details and decides who may speak.

Some networks (mobile data, many home routers, office Wi-Fi) block direct connections. When two people can't connect directly within about 7 seconds, their audio automatically goes through the Petty Court server instead, at phone-call quality. No extra accounts are needed. The voice bar shows "through the server" when this happens. On the relay, headphones help avoid echo. Only people the judge allows to speak are forwarded; the server drops everyone else's audio.

Adding a TURN relay (see Optional settings) lets more people connect directly, which gives slightly better quality and uses less of your server's bandwidth. It's optional.

This works well for a courtroom of up to about 10 people in voice. Bigger rooms would need a media server such as LiveKit.
