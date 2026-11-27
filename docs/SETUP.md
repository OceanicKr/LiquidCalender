# Setting up Google sign-in

You only do this once. It's free, and Google won't ask for a card if you skip the "free trial" banner.

Before you start, load the extension (see the README) and open a new tab. You'll need the **redirect URL** shown there. It looks like `https://abcdefghijklmnop.chromiumapp.org/` and is different for every install.

## 1. Make a project and turn on the APIs

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
2. Use the project picker at the top left to create a **New Project**. Call it anything.
3. With that project selected, enable both of these:
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com) (skip it if you don't use Tasks)

## 2. Set up the consent screen

Open **Google Auth Platform** (search for "OAuth consent screen" if you can't find it).

1. **Branding:** fill in an app name and your email. Nothing else is required.
2. **Audience:** user type **External**, and leave the status as **Testing**.
3. Still under **Audience**, find **Test users**, click **Add users**, and add the Google account whose calendar you want to see.

Testing mode is fine for personal use and doesn't need Google to review anything. Only the test users you list can sign in.

## 3. Create the client

1. Go to **Clients** → **Create client**.
2. Application type: **Web application**. Don't pick "Chrome extension": that type only works with Chrome's built-in sign-in, which Brave and Edge don't have.
3. Under **Authorized redirect URIs**, click **Add URI** and paste the redirect URL from your new tab page. Keep the `https://` and the slash at the end.
4. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You don't need the client secret.

## 4. Connect

Back on the new tab page, paste the client ID, click **Connect Google Calendar**, and choose your account.

Google will probably say "Google hasn't verified this app". That's because it's your own app in testing mode. Click **Continue**, then allow access to Calendar and Tasks.

## If it goes wrong

**`redirect_uri_mismatch`:** the redirect URL in Google Cloud doesn't exactly match the one on your new tab page. Copy it again from the page. Also check whether you moved the extension folder, since that changes the URL. After saving, Google can take a few minutes to catch up.

**Setting it up on a second computer (say Windows and Linux):** the redirect URL is different on each computer. Don't make a new client: add the second computer's redirect URL to the same client as an extra **Authorized redirect URI**, and paste the same client ID there.

**Can't find your project in Google Cloud:** it belongs to whichever Google account you were signed in with when you made it. Switch accounts with the avatar at the top right of the console.

**It keeps asking you to connect:** look at the red line under the Connect button, it says why the automatic sign-in failed. If you click Connect once and pick the right account, it remembers that account for next time.

**"Access blocked: app has not completed verification" / `access_denied`:** the account you picked isn't in **Test users**. Add it.

**"Access blocked" by your administrator:** work and school Google accounts often block unverified apps, and only the admin can change that. Use a personal Gmail instead. To keep seeing your work calendar, share it with that Gmail from Google Calendar's settings.

**Events show up but tasks don't:** the Tasks API isn't enabled in step 1.
