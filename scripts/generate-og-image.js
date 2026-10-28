const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function generate() {
  const outputPath = path.join(__dirname, '..', 'public', 'images', 'og-geoguide.png');
  const faviconSvg = fs.readFileSync(path.join(__dirname, '..', 'favicon.svg'), 'utf8');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1200px;
      height: 630px;
      background: radial-gradient(circle at 50% 40%, #17281c 0%, #0c140e 70%, #080c09 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    .grid-bg {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image: 
        linear-gradient(rgba(141, 191, 154, 0.08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(141, 191, 154, 0.08) 1px, transparent 1px);
      background-size: 40px 40px;
      pointer-events: none;
    }
    .glow {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 700px;
      height: 500px;
      background: radial-gradient(circle, rgba(74, 124, 89, 0.25) 0%, transparent 70%);
      pointer-events: none;
    }
    .card {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 24px;
    }
    .logo-wrap {
      width: 150px;
      height: 150px;
      filter: drop-shadow(0 16px 32px rgba(0,0,0,0.6));
    }
    .brand {
      font-size: 76px;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: #ffffff;
      line-height: 1;
    }
    .tagline {
      font-size: 26px;
      font-weight: 500;
      color: #8dbf9a;
      letter-spacing: 0.04em;
    }
  </style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="glow"></div>
  <div class="card">
    <div class="logo-wrap">${faviconSvg}</div>
    <div class="brand">GeoGuide</div>
    <div class="tagline">Interactive Regional Guide & Street View</div>
  </div>
</body>
</html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html);
  await page.screenshot({ path: outputPath, type: 'png' });
  await browser.close();
  console.log('Regenerated clean minimalist OG image at:', outputPath);
}

generate().catch(err => {
  console.error('Failed to generate OG image:', err);
  process.exit(1);
});
