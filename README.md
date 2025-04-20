# Kuro - Remotion Video Project

This project creates a credit roll video using Remotion.

## Setup

Before building the project, make sure you have the following files in place:

1. `public/members.csv` - Copy from `public/members.example.csv`
2. `public/images/example.gif` - Add your own GIF file

## Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Build video
npm run build
```

## Configuration

The video configuration can be found in:
- `src/Video.tsx` - Main composition settings (duration, fps, dimensions)
- `src/CreditRoll.tsx` - Credit roll animation and styling
- `remotion.config.ts` - Remotion configuration (codec, output settings)

[See in action](https://youtu.be/4K6fSzg6nGQ?t=2451)

<details><summary>Screenshot</summary><img width="1601" alt="image" src="https://user-images.githubusercontent.com/248741/170176427-9e3c9d88-9536-4646-99a8-6bfa3fb58ac6.png"></details>
