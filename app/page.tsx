"use client";
import TrueScoreApp from "./components/TrueScoreApp";

export default function Page() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.TRUESCORE_API = "${process.env.NEXT_PUBLIC_API_URL || ""}"`,
        }}
      />
      <TrueScoreApp />
    </>
  );
}
