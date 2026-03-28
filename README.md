# DriveDeck

DriveDeck is a lightweight slideshow app that:

- accepts a Google Drive folder link
- shows the folder structure
- displays all images in a grid
- opens any image in a slideshow with keyboard navigation
- can store phone-to-TV pairing codes in Firebase Firestore

## Run it

1. Create a Google Drive API key and enable the Google Drive API in Google Cloud.
2. Create a Firebase project and a Firestore database if you want cloud-backed pairing codes.
3. Create a Firebase service account for the server.
4. Either put the keys in a local `.env` file or export them before starting the app.

```bash
export GOOGLE_DRIVE_API_KEY=your_key_here
export FIREBASE_SERVICE_ACCOUNT_BASE64=your_base64_service_account_json_here
npm start
```

5. Open `http://localhost:3000`

## Notes

- The folder should be shared in a way the API key can access.
- Pairing codes use Firestore when Firebase credentials are present. Otherwise they fall back to the local `data/remote-links.txt` file.
- Arrow keys move between slides.
- `Esc` closes the slideshow.

## Deploy on Render

1. Push this project to GitHub, GitLab, or Bitbucket.
2. In Render, create a new Blueprint or Web Service from that repo.
3. Use the included [`render.yaml`](/Users/kaustubh.mokashi/Documents/Google%20Drive%20Slideshow/render.yaml).
4. Add these environment variables in Render:

```text
GOOGLE_DRIVE_API_KEY=your_google_drive_api_key
FIREBASE_SERVICE_ACCOUNT_BASE64=your_base64_encoded_service_account_json
FIREBASE_PAIRING_COLLECTION=pairingCodes
```

5. After the service is live, point the Android TV app to the Render URL in:
   [`drivedeck-android-tv/gradle.properties`](/Users/kaustubh.mokashi/Documents/Google%20Drive%20Slideshow/drivedeck-android-tv/gradle.properties)

Example:

```properties
drivedeckBaseUrl=https://your-render-service.onrender.com
drivedeckPairingUrl=
```

For Render deployment, the Firebase JSON file itself should not be committed. Use the `FIREBASE_SERVICE_ACCOUNT_BASE64` environment variable in the Render dashboard instead.
