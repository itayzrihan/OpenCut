import { RenderQueueRoot } from "@/export/queue/root";
import { ThemeProvider } from "next-themes";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { BotIdClient } from "botid/client";
import { webEnv } from "@/env/web";
import { Inter } from "next/font/google";
import { LocaleProvider } from "@/i18n/provider";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" dir="ltr" suppressHydrationWarning>
			<head>
				<Script src="/account-scope.js" strategy="beforeInteractive" />
				<BotIdClient protect={protectedRoutes} />
			</head>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					disableTransitionOnChange={true}
				>
					<LocaleProvider>
						<TooltipProvider>
							<Toaster />
							{webEnv.OPENCUT_ENABLE_TELEMETRY === "true" && (
								<Script
									src="https://cdn.databuddy.cc/databuddy.js"
									strategy="afterInteractive"
									async
									data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
									data-disabled={webEnv.NODE_ENV === "development"}
									data-track-attributes={false}
									data-track-errors={true}
									data-track-outgoing-links={false}
									data-track-web-vitals={false}
									data-track-sessions={false}
								/>
							)}
							<RenderQueueRoot>{children}</RenderQueueRoot>
						</TooltipProvider>
					</LocaleProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
