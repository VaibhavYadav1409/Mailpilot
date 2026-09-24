import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ClipboardList, Mail } from "lucide-react";
import { msiApi } from "@/lib/api";

/**
 * Slim module switcher on the left edge of the employee app: Mail (the
 * existing inbox) and MSI Daily Report. The MSI item carries a status dot —
 * red until today's report is in, green after — from one cached request
 * (no polling; it refreshes whenever the MSI page updates the cache).
 */
export function ModuleRail() {
  const [location] = useLocation();
  const today = useQuery({
    queryKey: ["msi", "today"],
    queryFn: msiApi.today,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const items = [
    { href: "/", label: "Mail", icon: Mail, active: location === "/" },
    { href: "/msi", label: "MSI Report", icon: ClipboardList, active: location.startsWith("/msi"), msi: true },
  ];

  return (
    <nav
      aria-label="Modules"
      className="hidden sm:flex w-[76px] shrink-0 flex-col items-center gap-1 border-r bg-card py-3"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const submitted = today.data?.submitted;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.msi ? "MSI Daily Work Report" : "Mail"}
            className={`relative flex w-[64px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10.5px] font-medium transition-colors ${
              item.active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <span className="relative">
              <Icon className="h-5 w-5" />
              {item.msi && today.data && (
                <span
                  className={`absolute -right-1.5 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-card ${
                    submitted ? "bg-green-500" : "bg-red-500"
                  }`}
                  aria-label={submitted ? "Today's report submitted" : "Today's report not submitted"}
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
