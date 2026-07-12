import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

// Deliberately not using next/font/google (Inter): that loader fetches from
// fonts.googleapis.com at build time, which fails the build in offline /
// firewalled CI and Docker environments. globals.css already declares an
// Inter-first system-font fallback stack, so this keeps the same look
// without a hard network dependency during `next build`.

export const metadata: Metadata = {
  title: "MailPilot Admin",
  description: "Enterprise Email Analytics Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Runs before paint so the correct theme class is applied
          // immediately — avoids a flash of the wrong theme on load.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('mailpilot-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
