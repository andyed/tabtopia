# Hero Images Testing Guide

This document outlines the procedure for testing the hero image extraction and display functionality in Histospire.

## Overview

Hero images are automatically extracted from web pages when:
1. The user has spent at least 60 seconds on the page (dwell time)
2. The user has scrolled at least 500 pixels down the page

Images are then stored and associated with the page URL for display in the sessions view.

## Testing the Debug Injector

The debug injector adds a button to web pages that allows manually triggering hero image extraction:

1. Load the extension in developer mode
2. Navigate to a web page with images (e.g., a news site)
3. Look for a "📸 Extract Hero Images" button in the bottom-right corner
4. Click the button to manually extract hero images
5. You should see an alert confirming successful extraction

## Testing the Debug Tools

The debug tools allow viewing and managing stored hero images:

1. Open a new tab to access the extension's newtab page
2. Open the browser console (F12 or right-click > Inspect)
3. Run the following command to view stored hero images:
   ```javascript
   window.histospireDebug.viewStoredHeroImages()
   ```
4. You should see a log of all URLs with hero images in the console

Alternatively, if using ES modules:
```javascript
import { viewStoredHeroImages } from './debug-tools-bridge.js';
viewStoredHeroImages();
```

## Testing Automatic Extraction

1. Navigate to a page with images
2. Stay on the page for at least 60 seconds
3. Scroll down at least 500 pixels
4. Hero images should be automatically extracted
5. Verify using debug tools as described above

## Testing Hero Images in Sessions View

1. After capturing hero images as described above
2. Open a new tab to view the extension's newtab page
3. Navigate to the "Sessions" tab
4. Find the session containing the page you visited
5. Verify that hero images appear as thumbnails in the session card
6. Click on a thumbnail to expand the hero image

## Troubleshooting

If hero images are not being displayed:

1. Check if images were successfully extracted:
   ```javascript
   window.histospireDebug.viewStoredHeroImages()
   ```
2. Verify that the page URL in storage exactly matches the URL used in sessions
3. Check browser console for any errors during extraction or display
4. Ensure the page was visited for at least 60 seconds and scrolled at least 500px

## Clearing Stored Hero Images

To clear all stored hero images:
```javascript
window.histospireDebug.clearAllHeroImages()
```

Or using ES modules:
```javascript
import { clearAllHeroImages } from './debug-tools-bridge.js';
clearAllHeroImages();
```

## Manual Forced Extraction

To manually trigger hero image extraction for testing:
```javascript
import { forceExtractHeroImages } from './debug-tools-bridge.js';
forceExtractHeroImages();
```
