const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// --- INITIAL DEFAULT DATA SET ---
const DEFAULT_SHELTERS = [
    {
        id: 1,
        name: "Kalinga Stadium Relief Camp",
        lat: 20.2880,
        lng: 85.8170,
        capacity: 1000,
        current: 450,
        phone: "0674-211111",
        inventory: { Food: 500, Water: 1000 }
    },
    {
        id: 2,
        name: "OUAT Auditorium",
        lat: 20.2720,
        lng: 85.8050,
        capacity: 500,
        current: 490,
        phone: "0674-222222",
        inventory: { Blankets: 100 }
    },
    {
        id: 3,
        name: "KIIT Guest House",
        lat: 20.3540,
        lng: 85.8160,
        capacity: 300,
        current: 50,
        phone: "0674-233333",
        inventory: {}
    }
];

// Default disaster bulletins start empty so no dummy data is shown to citizens
const DEFAULT_BULLETINS = [];

// --- ONLINE DATA STORE ---
let shelters = JSON.parse(JSON.stringify(DEFAULT_SHELTERS));
let disasterBulletins = JSON.parse(JSON.stringify(DEFAULT_BULLETINS));
let sosAlerts = [];
let supplyRequests = [];
let emergencyBroadcasts = [];
let activeEmergencyAlert = null;

// Persistent File Storage Engine
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    }
}

function loadDatabase() {
    ensureDataDir();
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (Array.isArray(data.shelters) && data.shelters.length > 0) shelters = data.shelters;
            if (Array.isArray(data.disasterBulletins)) disasterBulletins = data.disasterBulletins;
            if (Array.isArray(data.sosAlerts)) sosAlerts = data.sosAlerts;
            if (Array.isArray(data.supplyRequests)) supplyRequests = data.supplyRequests;
            if (Array.isArray(data.emergencyBroadcasts)) emergencyBroadcasts = data.emergencyBroadcasts;
            if (data.activeEmergencyAlert !== undefined) activeEmergencyAlert = data.activeEmergencyAlert;
            console.log('[CLOUD STORAGE] Persistent JSON storage loaded from data/db.json');
        } catch (e) {
            console.warn('[CLOUD STORAGE] Error loading db.json, using defaults', e);
        }
    }
}

function saveDatabase() {
    ensureDataDir();
    try {
        const payload = {
            shelters,
            disasterBulletins,
            sosAlerts,
            supplyRequests,
            emergencyBroadcasts,
            activeEmergencyAlert,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
        console.warn('[CLOUD STORAGE] Error saving to db.json', e);
    }
}

// Load persisted records on startup
loadDatabase();

// Real-time SSE Clients
const sseClients = new Set();

function notifySseClients(eventType, data) {
    const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(payload);
        } catch (e) {
            sseClients.delete(client);
        }
    }
}

const ROLE_PASSWORDS = {
    rescuer: ["rescuer", "res@123", "rescue", "rescuer123"],
    manager: ["shelter", "mgr@123", "manager", "shelter123"],
    ngo: ["ngo", "ngo123", "donor"],
    disaster: ["disaster", "gov@123", "admin", "disaster123"],
    disaster_mgmt: ["disaster", "gov@123", "admin", "disaster123", "dm"]
};

// Helper: Response Formatter with CORS
function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// Helper: Parse Request Body
function getRequestBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
    // Handle CORS Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    // Normalize URL path to accept routes both with and without '/api'
    let rawPath = req.url.split('?')[0];
    let path = rawPath.startsWith('/api') ? rawPath.substring(4) : rawPath;
    if (!path || path === '') path = '/';

    const method = req.method;

    // --- HEALTH CHECK ---
    if (method === 'GET' && (path === '/health' || path === '/')) {
        return sendJSON(res, 200, {
            status: "OK",
            server: "Rakshak Online Cloud Server",
            activeEmergencyAlert: activeEmergencyAlert ? activeEmergencyAlert.title : null,
            bulletinsCount: disasterBulletins.length,
            timestamp: new Date().toISOString()
        });
    }

    // --- REAL-TIME SERVER-SENT EVENTS (SSE) STREAM ---
    if (method === 'GET' && (path === '/events' || path === '/stream')) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        // Send initial connection heartbeat & current active alert status
        res.write(`event: connected\ndata: ${JSON.stringify({
            connected: true,
            activeAlert: activeEmergencyAlert,
            bulletinsCount: disasterBulletins.length,
            timestamp: new Date().toISOString()
        })}\n\n`);

        sseClients.add(res);
        req.on('close', () => {
            sseClients.delete(res);
        });
        return;
    }

    // --- DATA RESET ENDPOINT ---
    if ((method === 'POST' || method === 'GET') && (path === '/reset' || path === '/admin/reset')) {
        shelters = JSON.parse(JSON.stringify(DEFAULT_SHELTERS));
        disasterBulletins = [];
        sosAlerts = [];
        supplyRequests = [];
        emergencyBroadcasts = [];
        activeEmergencyAlert = null;
        saveDatabase();
        notifySseClients('system_reset', { reset: true });
        console.log(`[CLOUD SERVER] 🔄 Database & Backend Data Reset to Default Clean State!`);
        return sendJSON(res, 200, {
            success: true,
            message: "Backend data reset to clean state successfully!",
            sheltersCount: shelters.length,
            bulletinsCount: 0,
            sosAlertsCount: 0,
            supplyRequestsCount: 0,
            broadcastsCount: 0,
            activeEmergencyAlert: null
        });
    }

    // --- ROLE AUTHENTICATION ---
    if (method === 'POST' && path === '/auth/verify-role') {
        const body = await getRequestBody(req);
        const role = (body.role || "").trim();
        const pwd = (body.password || "").trim().toLowerCase();
        const expected = ROLE_PASSWORDS[role];
        const isMatch = Array.isArray(expected)
            ? expected.map(p => p.toLowerCase()).includes(pwd)
            : (expected && expected.toLowerCase() === pwd);

        if (isMatch) {
            return sendJSON(res, 200, { success: true, role: role, token: `token-${role}-${Date.now()}` });
        }
        return sendJSON(res, 401, { success: false, error: "Incorrect password" });
    }

    // --- DISASTER BULLETINS API ---
    if (method === 'GET' && path === '/bulletins') {
        return sendJSON(res, 200, {
            success: true,
            count: disasterBulletins.length,
            bulletins: disasterBulletins
        });
    }

    if (method === 'POST' && path === '/bulletins') {
        const body = await getRequestBody(req);
        const title = (body.title || "").trim();
        const content = (body.content || body.message || body.description || "").trim();
        if (!title || !content) {
            return sendJSON(res, 400, { success: false, error: "Title and content are required" });
        }
        const now = new Date();
        const newBulletin = {
            id: body.id ? String(body.id) : ('bulletin_' + Date.now()),
            title: title,
            severity: (body.severity || body.type || "WARNING").toUpperCase(),
            region: (body.region || "All Sectors").trim(),
            content: content,
            timestamp: body.timestamp || now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            date: body.date || now.toLocaleDateString(),
            createdAt: new Date().toISOString()
        };

        // Upsert by ID to avoid duplicates
        disasterBulletins = disasterBulletins.filter(b => String(b.id) !== String(newBulletin.id));
        disasterBulletins.unshift(newBulletin);
        saveDatabase();

        console.log(`[CLOUD SERVER] 📢 Disaster Bulletin Published: [${newBulletin.severity}] ${newBulletin.title}`);
        notifySseClients('bulletin_new', newBulletin);
        return sendJSON(res, 201, { success: true, bulletin: newBulletin, bulletins: disasterBulletins });
    }

    if (method === 'DELETE' && path.startsWith('/bulletins/')) {
        const id = path.split('/')[2];
        const idx = disasterBulletins.findIndex(b => String(b.id) === String(id));
        if (idx !== -1) {
            const removed = disasterBulletins.splice(idx, 1)[0];
            saveDatabase();
            console.log(`[CLOUD SERVER] 🗑️ Removed Disaster Bulletin: ${removed.title}`);
            notifySseClients('bulletin_deleted', { id: removed.id });
            return sendJSON(res, 200, { success: true, message: "Bulletin deleted", deletedId: id, bulletins: disasterBulletins });
        }
        return sendJSON(res, 404, { success: false, error: "Bulletin not found" });
    }

    // --- EMERGENCY SIREN BROADCAST API ---
    if (method === 'GET' && path === '/broadcasts/active') {
        return sendJSON(res, 200, {
            success: true,
            activeAlert: activeEmergencyAlert
        });
    }

    if (method === 'GET' && path === '/broadcasts') {
        return sendJSON(res, 200, {
            success: true,
            activeAlert: activeEmergencyAlert,
            broadcasts: emergencyBroadcasts
        });
    }

    if (method === 'POST' && (path === '/broadcasts/cancel' || path === '/broadcasts/deactivate')) {
        if (activeEmergencyAlert) {
            const cancelled = { ...activeEmergencyAlert, active: false };
            activeEmergencyAlert = null;
            saveDatabase();
            console.log(`[CLOUD SERVER] 🔕 Emergency Broadcast CANCELLED: ${cancelled.title}`);
            notifySseClients('emergency_cancelled', { id: cancelled.id });
            return sendJSON(res, 200, {
                success: true,
                message: "Emergency siren broadcast deactivated.",
                activeAlert: null
            });
        }
        return sendJSON(res, 200, { success: true, message: "No active broadcast to cancel", activeAlert: null });
    }

    if (method === 'DELETE' && (path === '/broadcasts/active' || path === '/broadcasts')) {
        if (activeEmergencyAlert) {
            const cancelled = { ...activeEmergencyAlert, active: false };
            activeEmergencyAlert = null;
            saveDatabase();
            notifySseClients('emergency_cancelled', { id: cancelled.id });
            return sendJSON(res, 200, { success: true, message: "Active emergency alert deactivated", activeAlert: null });
        }
        return sendJSON(res, 200, { success: true, message: "No active emergency alert", activeAlert: null });
    }

    if (method === 'POST' && path === '/broadcasts') {
        const body = await getRequestBody(req);
        const title = (body.title || "").trim();
        const desc = (body.description || body.message || body.desc || body.content || "").trim();
        if (!title || !desc) {
            return sendJSON(res, 400, { success: false, error: "Title and description/message are required" });
        }
        const now = new Date();
        const newBroadcast = {
            id: body.id ? String(body.id) : ('emergency_' + Date.now()),
            title: title,
            description: desc,
            issuer: (body.issuer || body.sender || "Disaster Management Authority").trim(),
            severity: (body.severity || "CRITICAL").toUpperCase(),
            targetArea: (body.targetArea || body.region || "ALL SECTORS / STATEWIDE").trim(),
            timestamp: body.timestamp || now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            date: body.date || now.toLocaleDateString(),
            active: true,
            createdAt: new Date().toISOString()
        };

        activeEmergencyAlert = newBroadcast;
        emergencyBroadcasts = emergencyBroadcasts.filter(b => String(b.id) !== String(newBroadcast.id));
        emergencyBroadcasts.unshift(newBroadcast);
        if (emergencyBroadcasts.length > 50) emergencyBroadcasts.pop();

        // Also mirror into disaster bulletins feed so citizens see it in their live updates feed
        const mirrorBulletin = {
            id: 'bulletin_' + newBroadcast.id,
            title: `🚨 ${newBroadcast.title}`,
            severity: 'CRITICAL',
            region: newBroadcast.targetArea || 'ALL SECTORS / STATEWIDE',
            content: `${newBroadcast.description} [Issued by ${newBroadcast.issuer}]`,
            timestamp: newBroadcast.timestamp,
            date: newBroadcast.date,
            createdAt: newBroadcast.createdAt
        };
        disasterBulletins = disasterBulletins.filter(b => String(b.id) !== String(mirrorBulletin.id));
        disasterBulletins.unshift(mirrorBulletin);
        saveDatabase();

        console.log(`[CLOUD SERVER] 🚨 EMERGENCY SIREN BROADCAST ACTIVATED: ${newBroadcast.title} [${newBroadcast.targetArea}]`);
        notifySseClients('emergency_broadcast', newBroadcast);
        notifySseClients('bulletin_new', mirrorBulletin);

        return sendJSON(res, 201, {
            success: true,
            activeAlert: activeEmergencyAlert,
            broadcast: newBroadcast,
            bulletin: mirrorBulletin,
            broadcasts: emergencyBroadcasts
        });
    }

    // --- SHELTERS API ---
    if (method === 'GET' && path === '/shelters') {
        return sendJSON(res, 200, { success: true, count: shelters.length, shelters });
    }

    if (method === 'POST' && path === '/shelters') {
        const body = await getRequestBody(req);
        if (!body.name || !body.capacity) {
            return sendJSON(res, 400, { success: false, error: "Name and capacity are required" });
        }
        const newShelter = {
            id: body.id ? parseInt(body.id) : Date.now(),
            name: body.name,
            lat: parseFloat(body.lat) || 20.2961,
            lng: parseFloat(body.lng) || 85.8245,
            capacity: parseInt(body.capacity),
            current: parseInt(body.current) || 0,
            phone: body.phone || "",
            inventory: body.inventory || {}
        };
        shelters = shelters.filter(s => s.id !== newShelter.id);
        shelters.push(newShelter);
        saveDatabase();
        console.log(`[CLOUD SERVER] Registered Shelter: ${newShelter.name}`);
        notifySseClients('shelter_update', { shelter: newShelter });
        return sendJSON(res, 201, { success: true, shelter: newShelter });
    }

    if (method === 'PUT' && path.startsWith('/shelters/') && path.endsWith('/occupancy')) {
        const parts = path.split('/');
        const id = parseInt(parts[2]);
        const body = await getRequestBody(req);
        const shelter = shelters.find(s => s.id === id);
        if (!shelter) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        shelter.current = parseInt(body.current);
        saveDatabase();
        console.log(`[CLOUD SERVER] Updated Occupancy: ${shelter.name} -> ${shelter.current}/${shelter.capacity}`);
        notifySseClients('shelter_occupancy', { id: shelter.id, current: shelter.current });
        return sendJSON(res, 200, { success: true, shelter });
    }

    if (method === 'DELETE' && path.startsWith('/shelters/')) {
        const id = parseInt(path.split('/')[2]);
        const idx = shelters.findIndex(s => s.id === id);
        if (idx === -1) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        const deleted = shelters.splice(idx, 1)[0];
        saveDatabase();
        console.log(`[CLOUD SERVER] Deleted Shelter: ${deleted.name}`);
        notifySseClients('shelter_deleted', { id });
        return sendJSON(res, 200, { success: true, message: `Shelter "${deleted.name}" deleted`, deletedId: id });
    }

    // --- SOS EMERGENCY ALERTS API ---
    if (method === 'GET' && path === '/sos') {
        return sendJSON(res, 200, { success: true, alerts: sosAlerts });
    }

    if ((method === 'DELETE' || method === 'POST') && (path === '/sos/clear' || (method === 'DELETE' && path === '/sos'))) {
        sosAlerts = [];
        saveDatabase();
        console.log(`[CLOUD SERVER] 🧹 Cleared all SOS alerts. Active alerts count: 0`);
        notifySseClients('sos_cleared', {});
        return sendJSON(res, 200, { success: true, message: "All SOS alerts cleared successfully", alerts: [] });
    }

    if (method === 'POST' && path === '/sos') {
        const body = await getRequestBody(req);
        const newAlert = {
            id: body.id || Date.now(),
            lat: parseFloat(body.lat) || 20.2961,
            lng: parseFloat(body.lng) || 85.8245,
            contact: body.contact || "Citizen in Distress",
            time: body.time || new Date().toLocaleTimeString(),
            status: body.status || "pending",
            message: body.message || "",
            medicalNotes: body.medicalNotes || "",
            isMesh: !!body.isMesh,
            hopCount: body.hopCount || 0,
            relayPath: body.relayPath || [],
            timestamp: body.timestamp || new Date().toISOString()
        };
        sosAlerts = sosAlerts.filter(a => String(a.id) !== String(newAlert.id));
        sosAlerts.unshift(newAlert);
        saveDatabase();
        console.log(`[CLOUD SERVER] 🚨 SOS Alert Triggered! Lat: ${newAlert.lat}, Lng: ${newAlert.lng}, Contact: ${newAlert.contact}`);
        notifySseClients('sos_new', newAlert);
        return sendJSON(res, 201, { success: true, alert: newAlert });
    }

    if (method === 'PUT' && path.startsWith('/sos/') && path.endsWith('/status')) {
        const id = path.split('/')[2];
        const body = await getRequestBody(req);
        const alert = sosAlerts.find(a => String(a.id) === String(id));
        if (!alert) return sendJSON(res, 404, { success: false, error: "Alert not found" });

        alert.status = body.status;
        saveDatabase();
        console.log(`[CLOUD SERVER] Updated SOS ${id} status to ${body.status}`);
        notifySseClients('sos_status', { id, status: body.status });
        return sendJSON(res, 200, { success: true, alert });
    }

    // --- SUPPLY REQUESTS & NGO PLEDGES API ---
    if (method === 'GET' && path === '/requests') {
        return sendJSON(res, 200, { success: true, requests: supplyRequests });
    }

    if (method === 'POST' && path === '/requests') {
        const body = await getRequestBody(req);
        const shelter = shelters.find(s => s.id === parseInt(body.shelterId));
        if (!shelter) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        const newReq = {
            id: body.id ? parseInt(body.id) : Date.now(),
            shelterId: shelter.id,
            shelterName: shelter.name,
            type: body.type,
            qty: parseInt(body.qty)
        };
        supplyRequests.unshift(newReq);
        saveDatabase();
        console.log(`[CLOUD SERVER] Broadcasted Supply Request: ${shelter.name} needs ${newReq.qty} ${newReq.type}`);
        notifySseClients('request_new', newReq);
        return sendJSON(res, 201, { success: true, request: newReq });
    }

    if (method === 'POST' && path === '/pledges') {
        const body = await getRequestBody(req);
        const shelter = shelters.find(s => s.id === parseInt(body.shelterId));
        if (!shelter) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        let fulfillmentStatus = "pledged";
        let remainingNeeded = 0;

        if (Array.isArray(body.items)) {
            body.items.forEach(item => {
                const pledgedQty = parseInt(item.qty);
                if (item.type && pledgedQty > 0) {
                    if (!shelter.inventory) shelter.inventory = {};
                    if (!shelter.inventory[item.type]) shelter.inventory[item.type] = 0;
                    shelter.inventory[item.type] += pledgedQty;

                    if (body.requestId) {
                        const reqId = parseInt(body.requestId);
                        const targetReq = supplyRequests.find(r => r.id === reqId);

                        if (targetReq && targetReq.type === item.type) {
                            if (pledgedQty >= targetReq.qty) {
                                supplyRequests = supplyRequests.filter(r => r.id !== reqId);
                                fulfillmentStatus = "full";
                                console.log(`[CLOUD SERVER] Request ${reqId} for ${shelter.name} FULLY FULFILLED!`);
                            } else {
                                targetReq.qty -= pledgedQty;
                                remainingNeeded = targetReq.qty;
                                fulfillmentStatus = "partial";
                                console.log(`[CLOUD SERVER] Request ${reqId} PARTIALLY FULFILLED. Remaining needed: ${targetReq.qty} ${targetReq.type}`);
                            }
                        }
                    }
                }
            });
        }

        saveDatabase();
        notifySseClients('pledge_fulfilled', { shelter, requests: supplyRequests });
        return sendJSON(res, 200, {
            success: true,
            shelter,
            requests: supplyRequests,
            fulfillmentStatus,
            remainingNeeded
        });
    }

    // Fallback 404
    return sendJSON(res, 404, { error: "Endpoint not found", path });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`🚀 Rakshak Cloud Online Server running on Port ${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/api/health`);
    console.log(`📢 Disaster Bulletins: http://localhost:${PORT}/api/bulletins`);
    console.log(`🚨 Emergency Broadcast: http://localhost:${PORT}/api/broadcasts`);
    console.log(`⚡ Live Event Stream (SSE): http://localhost:${PORT}/api/events`);
    console.log(`===================================================`);
});
