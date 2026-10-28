const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function makeIcons() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const svg = fs.readFileSync(path.join(__dirname, '..', 'favicon.svg'), 'utf8');
  
  // Render 192x192
  await page.setViewportSize({ width: 192, height: 192 });
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;width:192px;height:192px;">${svg.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="192" height="192"')}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, '..', 'public', 'images', 'icon-192.png'), omitBackground: true });

  // Render 32x32
  await page.setViewportSize({ width: 32, height: 32 });
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;width:32px;height:32px;">${svg.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="32" height="32"')}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, '..', 'public', 'images', 'icon-32.png'), omitBackground: true });

  // Render 512x512
  await page.setViewportSize({ width: 512, height: 512 });
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0;padding:0;display:flex;align-items:center;justify-content:center;background:transparent;width:512px;height:512px;">${svg.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" width="512" height="512"')}</body></html>`);
  await page.screenshot({ path: path.join(__dirname, '..', 'public', 'images', 'icon-512.png'), omitBackground: true });

  await browser.close();

  // Copy favicon.svg to public/
  fs.copyFileSync(path.join(__dirname, '..', 'favicon.svg'), path.join(__dirname, '..', 'public', 'favicon.svg'));

  console.log('Brand icons generated successfully!');
}

makeIcons().catch(console.error);
