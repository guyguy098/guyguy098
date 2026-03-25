/**
 * update-alerts-data.js
 * Runs via GitHub Actions every 30 minutes.
 * 1. Fetches alert history from tzevaadom.co.il (no CORS issues server-side)
 * 2. Merges with existing data (preserves historical alerts beyond the API's rolling window)
 * 3. Writes data/alert-history.json
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'alert-history.json');
const TELEGRAM_FILE = path.join(__dirname, '..', 'data', 'telegram-idf.json');
const ALERT_API = 'https://api.tzevaadom.co.il/alerts-history';
const TG_URL = 'https://t.me/s/IDFSpokesperson';

async function fetchAlerts() {
    console.log('Fetching from tzevaadom.co.il...');
    try {
        const resp = await fetch(ALERT_API, {
            headers: { 'User-Agent': 'TatzpitBot/1.0' },
            signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('Empty or invalid response');
        }
        console.log(`Fetched ${data.length} events from API`);
        return data;
    } catch (e) {
        console.error('Alert fetch failed:', e.message);
        return null;
    }
}

function mergeAlerts(existing, fresh) {
    // The API has a rolling window — merge to preserve historical data
    if (!existing || !existing.events) return fresh;
    if (!fresh) return existing.events;

    // Build a map of existing events by ID
    const byId = new Map();
    for (const ev of existing.events) {
        byId.set(ev.id, ev);
    }
    // Add/update with fresh data
    for (const ev of fresh) {
        byId.set(ev.id, ev); // fresh data overwrites
    }
    // Sort by newest first
    return [...byId.values()].sort((a, b) => {
        const tA = Math.min(...(a.alerts || []).map(al => al.time || 0));
        const tB = Math.min(...(b.alerts || []).map(al => al.time || 0));
        return tB - tA;
    });
}

async function main() {
    console.log('=== Alert History Update ===');
    console.log(`Time: ${new Date().toISOString()}`);

    // Load existing data
    let existing = null;
    try {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        existing = JSON.parse(raw);
        console.log(`Loaded existing: ${existing.events?.length || 0} events`);
    } catch (e) {
        console.log('No existing data file, starting fresh.');
    }

    // Fetch fresh data
    const freshData = await fetchAlerts();

    // Merge
    const merged = mergeAlerts(existing, freshData);
    if (!merged || merged.length === 0) {
        console.error('No data available at all. Exiting.');
        process.exit(existing ? 0 : 1); // Don't fail if we already have data
    }

    const output = {
        updated: new Date().toISOString(),
        source: 'tzevaadom.co.il',
        event_count: merged.length,
        events: merged,
    };

    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(output));
    console.log(`Written ${merged.length} events to ${DATA_FILE}`);
    // ── Telegram IDF Spokesperson ──────────────────────────────────────────
    console.log('\nFetching IDF Spokesperson Telegram...');
    try {
        const tgResp = await fetch(TG_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(15000),
        });
        if (!tgResp.ok) throw new Error(`HTTP ${tgResp.status}`);
        const tgHtml = await tgResp.text();
        console.log(`Telegram page fetched: ${tgHtml.length} chars`);

        // Extract entire message blocks (more robust than separate regex)
        const messages = [];
        const blockRegex = /<div class="tgme_widget_message "[^>]*data-post="([^"]*)"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gi;
        
        // Simpler approach: find all message texts and timestamps by scanning the HTML
        // Split by message boundary
        const msgParts = tgHtml.split('tgme_widget_message_bubble');
        console.log(`Found ${msgParts.length - 1} message bubbles`);

        for (let i = 1; i < msgParts.length; i++) {
            const part = msgParts[i];

            // Extract text content
            const textMatch = part.match(/js-message_text[^>]*>([\s\S]*?)<\/div>/i)
                           || part.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i);
            if (!textMatch) continue;

            let text = textMatch[1]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'")
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            if (text.length < 10) continue;

            // Extract timestamp
            const timeMatch = part.match(/<time[^>]*datetime="([^"]*)"/i);
            const ts = timeMatch ? timeMatch[1] : null;

            // Extract numbers about rockets/missiles/interceptions (works for both Hebrew and English)
            const nums = [];
            const numberPatterns = [
                /(\d+)\s*(rocket|missile|projectile|UAV|drone|aerial)/gi,
                /intercept(?:ed)?\s+(\d+)/gi,
                /(\d+)\s*(רקט|טיל|כטב"מ|שיגור|יירוט)/gi,
                /(יירט|יורט|שוגר|שוגרו)\s*(\d+)/gi,
            ];
            for (const rx of numberPatterns) {
                for (const m of text.matchAll(rx)) {
                    nums.push(m[0]);
                }
            }

            messages.push({
                text: text.slice(0, 300),
                nums,
                ts,
            });
        }

        // Keep last 15 messages (no keyword filtering — everything from IDF channel is relevant)
        const recent = messages.slice(-15).reverse();

        const tgOutput = {
            updated: new Date().toISOString(),
            source: 'IDF Spokesperson Telegram',
            message_count: recent.length,
            messages: recent,
        };

        fs.writeFileSync(TELEGRAM_FILE, JSON.stringify(tgOutput, null, 2));
        console.log(`Written ${recent.length} messages to ${TELEGRAM_FILE}`);
    } catch (e) {
        console.warn('Telegram fetch failed:', e.message);
        // Don't fail the whole pipeline — alerts are more important
    }
	console.log('=== Done ===');
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
