import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Used for Auth sessions and Realtime channel subscriptions.
// Service-role key never goes here — backend only.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
