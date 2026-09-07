import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { sepolia, mainnet } from "wagmi/chains";

// walletConnectProjectId is a placeholder -- get a free one at cloud.walletconnect.com
// before deploying anywhere real. Everything else here works as-is for local dev.
export const wagmiConfig = getDefaultConfig({
  appName: "MarginMM Maker Dashboard",
  projectId: "REPLACE_WITH_REAL_WALLETCONNECT_PROJECT_ID",
  chains: [sepolia, mainnet],
  ssr: false,
});