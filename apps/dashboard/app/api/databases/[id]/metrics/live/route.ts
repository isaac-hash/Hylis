/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/services/prisma';
import { collectMetrics } from '@/services/database-metrics.service';

// ─── GET /api/databases/:id/metrics/live ──────────────────────────────────────
// Returns a live snapshot from the running container (connections, throughput, slow queries, size)

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: databaseId } = await params;

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const session = await prisma.session.findUnique({
        where: { token },
        include: { user: { include: { organization: true } } },
    });
    if (!session || session.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Plan gate: Database Analytics is a paid feature (PLATFORM_ADMIN bypasses)
    const plan = session.user.organization?.plan || 'FREE';
    if (plan === 'FREE' && session.user.role !== 'PLATFORM_ADMIN') {
        return NextResponse.json({ error: 'Database Analytics requires a PRO or ENTERPRISE plan.', upgrade: true }, { status: 403 });
    }

    const db = await prisma.database.findUnique({ where: { id: databaseId } });
    if (!db || db.organizationId !== session.user.organizationId) {
        return NextResponse.json({ error: 'Database not found' }, { status: 404 });
    }

    if (db.status !== 'RUNNING') {
        return NextResponse.json({ error: 'Database is not running' }, { status: 400 });
    }

    try {
        const snapshot = await collectMetrics(databaseId);
        return NextResponse.json(snapshot);
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to collect live metrics' }, { status: 500 });
    }
}
