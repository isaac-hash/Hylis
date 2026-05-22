import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/services/prisma';
import { getMetricsHistory, collectAndPersistMetrics } from '@/services/database-metrics.service';

// ─── GET /api/databases/:id/metrics?hours=24 ─────────────────────────────────
// Returns historical time-series data for charts

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

    // Verify database belongs to user's organization
    const db = await prisma.database.findUnique({ where: { id: databaseId } });
    if (!db || db.organizationId !== session.user.organizationId) {
        return NextResponse.json({ error: 'Database not found' }, { status: 404 });
    }

    const hours = parseInt(req.nextUrl.searchParams.get('hours') || '24', 10);
    const metrics = await getMetricsHistory(databaseId, Math.min(hours, 168)); // Max 7 days

    return NextResponse.json(metrics);
}

// ─── POST /api/databases/:id/metrics ──────────────────────────────────────────
// Trigger immediate metric collection

export async function POST(
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

    const plan = session.user.organization?.plan || 'FREE';
    if (plan === 'FREE' && session.user.role !== 'PLATFORM_ADMIN') {
        return NextResponse.json({ error: 'Database Analytics requires a PRO or ENTERPRISE plan.', upgrade: true }, { status: 403 });
    }

    const db = await prisma.database.findUnique({ where: { id: databaseId } });
    if (!db || db.organizationId !== session.user.organizationId) {
        return NextResponse.json({ error: 'Database not found' }, { status: 404 });
    }

    const snapshot = await collectAndPersistMetrics(databaseId);
    if (!snapshot) {
        return NextResponse.json({ error: 'Failed to collect metrics' }, { status: 500 });
    }

    return NextResponse.json(snapshot);
}
