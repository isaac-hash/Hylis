"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useAuth } from "@/providers/auth.provider";

import NotificationPanel from "@/components/NotificationPanel";

// Lined SVG icon components
const DashboardIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
    </svg>
);

const DeploymentsIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
    </svg>
);

const BillingIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
        <line x1="1" y1="10" x2="23" y2="10"/>
    </svg>
);

const AdminIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
);

const TemplatesIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4" />
        <polyline points="14 2 14 8 20 8" />
        <path d="M2 15h10" />
        <path d="m9 18 3-3-3-3" />
    </svg>
);

const StacksIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
);

const LogoutIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
);

const MarketplaceIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
);

const AnalyticsIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18"/>
        <path d="m7 16 4-4 4 4 4-7"/>
    </svg>
);

const UptimeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
);

const ErrorIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
    </svg>
);

type NavItem = {
    name: string;
    href: string;
    icon: React.ReactNode;
    badge?: string;
};

const navItems: NavItem[] = [
    { name: "Dashboard", href: "/dashboard", icon: <DashboardIcon /> },
    { name: "Stacks", href: "/stacks", icon: <StacksIcon /> },
    { name: "Templates", href: "/dashboard/templates", icon: <TemplatesIcon />, badge: "✨" },
    { name: "Marketplace", href: "/marketplace", icon: <MarketplaceIcon />, badge: "NEW" },
    { name: "Analytics", href: "/analytics", icon: <AnalyticsIcon /> },
    { name: "Uptime", href: "/uptime", icon: <UptimeIcon /> },
    { name: "Errors", href: "/errors", icon: <ErrorIcon /> },
    { name: "Deployments", href: "/deployments", icon: <DeploymentsIcon /> },
    { name: "Billing", href: "/billing", icon: <BillingIcon /> },
];

export default function Sidebar({ 
    isOpen, 
    onClose 
}: { 
    isOpen?: boolean, 
    onClose?: () => void 
}) {
    const pathname = usePathname();
    const { user, logout } = useAuth();
    const [isCollapsed, setIsCollapsed] = useState(false);

    return (
        <>
            {/* Mobile Backdrop */}
            {isOpen && (
                <div 
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden animate-in fade-in duration-300"
                    onClick={onClose}
                />
            )}

            <aside 
                className={`fixed top-0 left-0 h-screen glass border-r transition-all duration-300 z-50 flex flex-col ${
                    isOpen ? "translate-x-0" : "-translate-x-full"
                } ${
                    isCollapsed ? "md:w-20" : "md:w-64"
                } md:translate-x-0 md:static md:flex md:h-screen md:shrink-0`}
            >
                {/* Logo Section */}
                <div className="p-6 flex items-center justify-between mb-4">
                    <Link href="/" className="flex items-center gap-3 group">
                        <div className="w-8 h-8 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0">
                            <Image src="/Hylius-Logo-9.png" alt="Hylius Logo" width={32} height={32} className="w-full h-full object-contain" />
                        </div>
                        <span className={`font-display font-bold text-xl tracking-tight animate-reveal ${isCollapsed ? "md:hidden" : "block"}`}>
                            Hylius
                        </span>
                    </Link>
                    
                    {/* Desktop Actions */}
                    <div className="hidden md:flex items-center gap-2 flex-col md:flex-row">
                        {!isCollapsed && <NotificationPanel align="left" />}
                        {/* Desktop Collapse Button */}
                        <button 
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors"
                            title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
                        >
                            {isCollapsed ? "→" : "←"}
                        </button>
                    </div>

                    {/* Mobile Close Button */}
                    <button 
                        onClick={onClose}
                        className="md:hidden p-1.5 rounded-lg hover:bg-white/5 text-gray-500"
                    >
                        ✕
                    </button>
                </div>

                {/* Navigation Links */}
                <nav className="flex-1 px-4 space-y-1 overflow-y-auto overflow-x-hidden">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-all group ${
                                    isActive 
                                        ? "bg-blue-600/10 text-blue-400 border border-blue-500/20" 
                                        : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
                                }`}
                                onClick={onClose}
                            >
                                <span className="shrink-0 flex items-center justify-center">{item.icon}</span>
                                <span className={`font-medium text-sm transition-opacity duration-200 ${isCollapsed ? "md:opacity-0 md:w-0 overflow-hidden" : "opacity-100"}`}>
                                    {item.name}
                                </span>
                                {item.badge && !isCollapsed ? (
                                    <span className="ml-auto text-xs">{item.badge}</span>
                                ) : isActive && !isCollapsed ? (
                                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] md:block hidden"></div>
                                ) : null}
                            </Link>
                        );
                    })}

                    {user?.role === 'PLATFORM_ADMIN' && (
                        <div className="pt-4 mt-4 border-t border-white/10">
                            <Link
                                href="/admin"
                                className={`flex items-center gap-3 px-3 py-3 rounded-xl transition-all group ${
                                    pathname.startsWith("/admin")
                                        ? "bg-blue-600/10 text-blue-400 border border-blue-500/20"
                                        : "text-gray-400 hover:text-white hover:bg-white/5 border border-transparent"
                                }`}
                                onClick={onClose}
                            >
                                <span className="shrink-0 flex items-center justify-center"><AdminIcon /></span>
                                <span className={`font-medium text-sm ${isCollapsed ? "md:hidden" : "block"}`}>Admin Panel</span>
                            </Link>
                        </div>
                    )}
                </nav>

                {/* Mascot Animation */}
                <div className={`mt-auto px-4 pb-4 flex justify-center ${isCollapsed ? "md:hidden" : ""}`}>
                    <div className="relative group cursor-pointer">
                        <style dangerouslySetInnerHTML={{__html: `
                            @keyframes bot-float {
                                0%, 100% { transform: translateY(0); }
                                50% { transform: translateY(-5px); }
                            }
                            @keyframes bot-blink {
                                0%, 48%, 52%, 100% { transform: scaleY(1); }
                                50% { transform: scaleY(0.1); }
                            }
                            @keyframes bot-antenna {
                                0%, 100% { transform: rotate(0deg); }
                                25% { transform: rotate(10deg); }
                                75% { transform: rotate(-10deg); }
                            }
                        `}} />
                        <svg width="48" height="48" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ animation: 'bot-float 3s ease-in-out infinite' }}>
                            {/* Body */}
                            <rect x="16" y="24" width="32" height="28" rx="6" fill="#1e293b" stroke="#475569" strokeWidth="2"/>
                            {/* Face Screen */}
                            <rect x="20" y="28" width="24" height="14" rx="3" fill="#0f172a" />
                            {/* Eyes (Blinking) */}
                            <g style={{ animation: 'bot-blink 4s infinite', transformOrigin: '50% 35px' }}>
                                <rect x="24" y="32" width="4" height="4" rx="1" fill="#3b82f6" />
                                <rect x="36" y="32" width="4" height="4" rx="1" fill="#3b82f6" />
                            </g>
                            {/* Smile */}
                            <path d="M28 38 Q32 40 36 38" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" fill="none" />
                            {/* Antenna */}
                            <g style={{ animation: 'bot-antenna 2s ease-in-out infinite', transformOrigin: '32px 24px' }}>
                                <line x1="32" y1="24" x2="32" y2="12" stroke="#475569" strokeWidth="2" strokeLinecap="round"/>
                                <circle cx="32" cy="10" r="3" fill="#3b82f6" />
                            </g>
                            {/* Legs */}
                            <line x1="24" y1="52" x2="24" y2="58" stroke="#475569" strokeWidth="2" strokeLinecap="round"/>
                            <line x1="40" y1="52" x2="40" y2="58" stroke="#475569" strokeWidth="2" strokeLinecap="round"/>
                        </svg>
                        
                        {/* Tooltip */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max px-3 py-1.5 bg-gray-800 text-xs text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-gray-700 shadow-xl z-50">
                            All systems nominal! 🚀
                            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-800"></div>
                        </div>
                    </div>
                </div>

                {/* User Profile / Logout */}
                <div className="p-4 border-t border-white/5">
                    <div className={`flex items-center gap-3 px-2 py-3 rounded-2xl ${isCollapsed ? "md:justify-center" : "bg-white/5"}`}>
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center font-bold text-xs shrink-0">
                            {user?.email?.[0].toUpperCase()}
                        </div>
                        <div className={`flex-1 min-w-0 ${isCollapsed ? "md:hidden" : "block"}`}>
                                <p className="text-xs font-semibold truncate text-white">{user?.email}</p>
                                <p className="text-[10px] text-gray-500 uppercase tracking-widest">{user?.role}</p>
                        </div>
                    </div>
                    
                    <button
                        onClick={logout}
                        className={`w-full mt-3 flex items-center gap-3 px-4 py-2 text-xs font-bold text-gray-400 hover:text-white hover:bg-red-500/10 rounded-xl transition-all border border-transparent hover:border-red-500/20 ${isCollapsed ? "md:justify-center" : ""}`}
                    >
                        <span className="flex items-center justify-center"><LogoutIcon /></span>
                        <span className={`${isCollapsed ? "md:hidden" : "block"}`}>Logout</span>
                    </button>
                </div>
            </aside>
        </>
    );
}
