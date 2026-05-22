import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/services/prisma';
import { createDatabase } from '@/services/database.service';

// ─── GET /api/databases?serverId=xxx ────────────────────────────────────────

export async function GET(req: NextRequest) {
    const serverId = req.nextUrl.searchParams.get('serverId');
    if (!serverId) {
        return NextResponse.json({ error: 'serverId query param is required' }, { status: 400 });
    }

    // Basic auth check via session token
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const databases = await prisma.database.findMany({
        where: { serverId },
        orderBy: { createdAt: 'desc' },
        select: {
            id: true, name: true, engine: true, version: true, status: true,
            containerName: true, port: true, dbName: true, dbUser: true,
            errorMessage: true, projectId: true, serverId: true, organizationId: true,
            createdAt: true, updatedAt: true,
            project: { select: { id: true, name: true } },
        },
    });

    return NextResponse.json(databases);
}

// ─── POST /api/databases ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { serverId, engine, name, version, projectId } = body;

    if (!serverId || !engine || !name) {
        return NextResponse.json({ error: 'serverId, engine, and name are required' }, { status: 400 });
    }

    const validEngines = ['POSTGRES', 'MYSQL', 'REDIS', 'MONGODB'];
    if (!validEngines.includes(engine)) {
        return NextResponse.json({ error: `engine must be one of: ${validEngines.join(', ')}` }, { status: 400 });
    }

    // Verify server belongs to user's organization
    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server || server.organizationId !== session.user.organizationId) {
        return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    // Create DB record and triggger provisioning (non-blocking — status is PROVISIONING)
    // The actual SSH provisioning is kicked off via Socket.io for real-time log streaming.
    // This REST endpoint just creates the record and returns the ID.
    const result = await createDatabase({
        serverId,
        organizationId: server.organizationId,
        engine,
        name,
        version,
        projectId: projectId || undefined,
    });

    if (result.error) {
        return NextResponse.json({ error: result.error, id: result.id }, { status: 500 });
    }

    return NextResponse.json({ id: result.id }, { status: 201 });
}
