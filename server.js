const http = require('http');

const PORT = process.env.PORT || 5000;

// --- ONLINE DATA STORE ---
let shelters = [
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

let sosAlerts = [];
let supplyRequests = [];

const ROLE_PASSWORDS = {
    rescuer: "rescuer",
    manager: "shelter",
    ngo: "NGO"
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
            timestamp: new Date().toISOString()
        });
    }

    // --- ROLE AUTHENTICATION ---
    if (method === 'POST' && path === '/auth/verify-role') {
        const body = await getRequestBody(req);
        const expected = ROLE_PASSWORDS[body.role];
        if (expected && body.password === expected) {
            return sendJSON(res, 200, { success: true, role: body.role, token: `token-${body.role}-${Date.now()}` });
        }
        return sendJSON(res, 401, { success: false, error: "Incorrect password" });
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
            id: Date.now(),
            name: body.name,
            lat: parseFloat(body.lat) || 20.2961,
            lng: parseFloat(body.lng) || 85.8245,
            capacity: parseInt(body.capacity),
            current: 0,
            phone: body.phone || "",
            inventory: {}
        };
        shelters.push(newShelter);
        console.log(`[CLOUD SERVER] Registered Shelter: ${newShelter.name}`);
        return sendJSON(res, 201, { success: true, shelter: newShelter });
    }

    if (method === 'PUT' && path.startsWith('/shelters/') && path.endsWith('/occupancy')) {
        const parts = path.split('/');
        const id = parseInt(parts[2]);
        const body = await getRequestBody(req);
        const shelter = shelters.find(s => s.id === id);
        if (!shelter) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        shelter.current = parseInt(body.current);
        console.log(`[CLOUD SERVER] Updated Occupancy: ${shelter.name} -> ${shelter.current}/${shelter.capacity}`);
        return sendJSON(res, 200, { success: true, shelter });
    }

    if (method === 'DELETE' && path.startsWith('/shelters/')) {
        const id = parseInt(path.split('/')[2]);
        const idx = shelters.findIndex(s => s.id === id);
        if (idx === -1) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        const deleted = shelters.splice(idx, 1)[0];
        console.log(`[CLOUD SERVER] Deleted Shelter: ${deleted.name}`);
        return sendJSON(res, 200, { success: true, message: `Shelter "${deleted.name}" deleted`, deletedId: id });
    }

    // --- SOS EMERGENCY ALERTS API ---
    if (method === 'GET' && path === '/sos') {
        return sendJSON(res, 200, { success: true, alerts: sosAlerts });
    }

    if (method === 'POST' && path === '/sos') {
        const body = await getRequestBody(req);
        const newAlert = {
            id: Date.now(),
            lat: parseFloat(body.lat) || 20.2961,
            lng: parseFloat(body.lng) || 85.8245,
            contact: body.contact || "No contact provided",
            time: new Date().toLocaleTimeString(),
            status: "pending",
            timestamp: new Date().toISOString()
        };
        sosAlerts.push(newAlert);
        console.log(`[CLOUD SERVER] 🚨 SOS Alert Triggered! Lat: ${newAlert.lat}, Lng: ${newAlert.lng}, Contact: ${newAlert.contact}`);
        return sendJSON(res, 201, { success: true, alert: newAlert });
    }

    if (method === 'PUT' && path.startsWith('/sos/') && path.endsWith('/status')) {
        const id = parseInt(path.split('/')[2]);
        const body = await getRequestBody(req);
        const alert = sosAlerts.find(a => a.id === id);
        if (!alert) return sendJSON(res, 404, { success: false, error: "Alert not found" });

        alert.status = body.status;
        console.log(`[CLOUD SERVER] Updated SOS ${id} status to ${body.status}`);
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
            id: Date.now(),
            shelterId: shelter.id,
            shelterName: shelter.name,
            type: body.type,
            qty: parseInt(body.qty)
        };
        supplyRequests.push(newReq);
        console.log(`[CLOUD SERVER] Broadcasted Supply Request: ${shelter.name} needs ${newReq.qty} ${newReq.type}`);
        return sendJSON(res, 201, { success: true, request: newReq });
    }

    if (method === 'POST' && path === '/pledges') {
        const body = await getRequestBody(req);
        const shelter = shelters.find(s => s.id === parseInt(body.shelterId));
        if (!shelter) return sendJSON(res, 404, { success: false, error: "Shelter not found" });

        if (Array.isArray(body.items)) {
            body.items.forEach(item => {
                if (item.type && item.qty > 0) {
                    if (!shelter.inventory[item.type]) shelter.inventory[item.type] = 0;
                    shelter.inventory[item.type] += parseInt(item.qty);
                }
            });
        }

        if (body.requestId) {
            supplyRequests = supplyRequests.filter(r => r.id !== parseInt(body.requestId));
        }

        console.log(`[CLOUD SERVER] NGO Pledge received for ${shelter.name}`);
        return sendJSON(res, 200, { success: true, shelter });
    }

    // Fallback 404
    return sendJSON(res, 404, { error: "Endpoint not found", path });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`🚀 Rakshak Cloud Online Server running on Port ${PORT}`);
    console.log(`📡 Health Check: http://localhost:${PORT}/api/health`);
    console.log(`===================================================`);
});
