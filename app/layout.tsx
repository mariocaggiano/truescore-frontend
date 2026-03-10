import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "TrueScore — Business Verification Intelligence",
  description: "Verifica le claim prima di firmare.",
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body style={{ margin: 0, padding: 0, background: "#0D0F1A" }}>
        {children}
      </body>
    </html>
  );
}
