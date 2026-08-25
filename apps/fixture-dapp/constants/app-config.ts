import { AppIdentity, createSolanaDevnet, SolanaCluster } from '@wallet-ui/react-native-kit'

export class AppConfig {
  static identity: AppIdentity = { name: 'LaunchRig Fixture' }
  static networks: SolanaCluster[] = [createSolanaDevnet({ url: 'https://api.devnet.solana.com' })]
}
