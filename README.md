# TikTok to Nostr

TikTok to Nostr is a Chrome Manifest V3 extension that turns the currently open TikTok video into a Nostr post.

It detects the active TikTok video, prepares a note draft, asks a backend service to resolve a downloadable media URL, uploads the video to a Blossom server, and publishes the final note through a NIP-07 browser signer.

## How It Works

1. Open a TikTok video in Chrome.
2. Open the extension popup or use the in-page share button.
3. Review or edit the note text.
4. Click `Upload and publish`.
5. The extension resolves the video through a backend service, uploads it to Blossom, signs the note with your browser signer, and publishes it to Nostr relays.

## Load Unpacked In Chrome

The repository includes a ready-to-load `dist/` folder.

1. Download or clone the repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the `dist` folder from this project.

## Requirements

- Google Chrome or another Chromium browser with extension developer mode enabled
- A NIP-07 compatible browser signer
- Access to a backend service that can resolve TikTok media URLs
- Access to a Blossom server for uploads

## Development

```bash
npm install
npm run build
```

Run the build only if you want to modify the extension source and regenerate `dist/`.

The extension source lives in `src/` and the backend worker lives in `backend/`.

## License

MIT
