import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ClipboardList, Mail } from "lucide-react";
import { msiApi } from "@/lib/api";
import { useAuth } from "@/_core/hooks/useAuth";

/**
 * Slim module switcher on the left edge of the employee app: Mail (the
 * existing inbox) and MIS Daily Report. The MIS item carries a status dot —
 * red until today's report is in, green after — from one cached request
 * (no polling; it refreshes whenever the MIS page updates the cache).
 */
export function ModuleRail() {
  const [location] = useLocation();
  const { user } = useAuth();
  // MIS staff (username logins) have no mailbox, so no Mail module.
  const misOnly = !!user && !user.email.includes("@");
  const today = useQuery({
    queryKey: ["msi", "today"],
    queryFn: msiApi.today,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const items = [
    ...(misOnly ? [] : [{ href: "/", label: "Mail", icon: Mail, active: location === "/" }]),
    { href: "/msi", label: "My MIS", icon: ClipboardList, active: location.startsWith("/msi"), msi: true },
  ];

  return (
    <nav
      aria-label="Modules"
      className="hidden sm:flex w-[76px] shrink-0 flex-col items-center gap-1 border-r bg-card py-3"
    >
      {items.map((item) => {
        const Icon = item.icon;
        // MIS staff: green when yesterday's MIS is complete (amber = some blanks).
        const misY = today.data?.misDays?.[0]?.mis.status;
        const submitted = misY ? misY === "COMPLETE" || misY === "OFF" : today.data?.submitted;
        const amber = misY === "INCOMPLETE";
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.msi ? "My MIS" : "Mail"}
            className={`relative flex w-[64px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10.5px] font-medium transition-colors ${
              item.active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <span className="relative">
              <Icon className="h-5 w-5" />
              {item.msi && today.data && (
                <span
                  className={`absolute -right-1.5 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                    submitted ? "bg-green-500" : amber ? "bg-amber-500" : "bg-red-500"
                  }`}
                  aria-label={submitted ? "MIS submitted" : amber ? "MIS has blanks" : "MIS not submitted"}
                />
              )}
            </span>
            <span className="text-center leading-tight">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
