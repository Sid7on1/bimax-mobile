import {isRunningInExpoGo} from 'expo';
import * as LocalAuthentication from 'expo-local-authentication';
/** Expo Go lacks the app's Face ID description; still require the phone's OS authentication. */
export async function confirmPhoneDecision(promptMessage:string):Promise<boolean>{
  const result=await LocalAuthentication.authenticateAsync({promptMessage,disableDeviceFallback:!isRunningInExpoGo(),biometricsSecurityLevel:'strong'});
  return result.success;
}
