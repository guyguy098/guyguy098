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
            headers: { 'User-Agent': 'TatzpitBot/1.0' },
            signal: AbortSignal.timeout(15000),
        });
        if (!tgResp.ok) throw new Error(`HTTP ${tgResp.status}`);
        const tgHtml = await tgResp.text();

        // Parse messages from Telegram public page HTML
        const messages = [];
        const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
        const timeRegex = /<time[^>]*datetime="([^"]*)"[^>]*>/gi;

        // Extract all timestamps
        const timestamps = [];
        let timeMatch;
        while ((timeMatch = timeRegex.exec(tgHtml)) !== null) {
            timestamps.push(timeMatch[1]);
        }

        // Extract all message texts
        let msgMatch;
        let msgIndex = 0;
        const keywords = /intercept|rocket|missile|launched|fired|UAV|drone|projectile|aerial|threat|iron dome|שיגור|יירוט|רקט/i;
        const numberRx = /(\d+)\s*(rocket|missile|projectile|UAV|drone|aerial)/gi;
        const interceptRx = /intercept(?:ed)?\s+(\d+)/gi;

        while ((msgMatch = msgRegex.exec(tgHtml)) !== null) {
            const rawText = msgMatch[1]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'")
                .trim();

            if (keywords.test(rawText) && messages.length < 10) {
                const nums = [];
                const m1 = [...rawText.matchAll(numberRx)];
                const m2 = [...rawText.matchAll(interceptRx)];
                m1.forEach(m => nums.push(m[0]));
                m2.forEach(m => nums.push('intercepted ' + m[1]));

                messages.push({
                    text: rawText.slice(0, 300),
                    nums,
                    ts: timestamps[msgIndex] || null,
                });
            }
            msgIndex++;
        }

        const tgOutput = {
            updated: new Date().toISOString(),
            source: 'IDF Spokesperson Telegram',
            message_count: messages.length,
            messages,
        };

        fs.writeFileSync(TELEGRAM_FILE, JSON.stringify(tgOutput, null, 2));
        console.log(`Written ${messages.length} intercept messages to ${TELEGRAM_FILE}`);
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