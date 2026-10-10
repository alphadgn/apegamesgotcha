export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_config: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
          version: number
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
          version?: number
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
          version?: number
        }
        Relationships: []
      }
      app_config_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: number
          key: string
          value: Json
          version: number
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: number
          key: string
          value: Json
          version: number
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: number
          key?: string
          value?: Json
          version?: number
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          created_at: string
          details: Json | null
          id: number
        }
        Insert: {
          action: string
          actor?: string | null
          created_at?: string
          details?: Json | null
          id?: number
        }
        Update: {
          action?: string
          actor?: string | null
          created_at?: string
          details?: Json | null
          id?: number
        }
        Relationships: []
      }
      burn_claims: {
        Row: {
          created_at: string
          id: string
          level: number
          token_id: string
          tx_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          level: number
          token_id: string
          tx_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          level?: number
          token_id?: string
          tx_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      contact_messages: {
        Row: {
          created_at: string
          email: string
          id: string
          message: string
          name: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      guide_messages: {
        Row: {
          created_at: string
          id: string
          parts: Json
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parts: Json
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parts?: Json
          role?: string
          user_id?: string
        }
        Relationships: []
      }
      nft_holdings: {
        Row: {
          burned: boolean
          level: number | null
          level_override: number | null
          owner_address: string
          synced_at: string
          token_id: string
          user_id: string | null
        }
        Insert: {
          burned?: boolean
          level?: number | null
          level_override?: number | null
          owner_address: string
          synced_at?: string
          token_id: string
          user_id?: string | null
        }
        Update: {
          burned?: boolean
          level?: number | null
          level_override?: number | null
          owner_address?: string
          synced_at?: string
          token_id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      points_ledger: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          id: number
          reason: string
          ref: string | null
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          id?: number
          reason: string
          ref?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          id?: number
          reason?: string
          ref?: string | null
          user_id?: string
        }
        Relationships: []
      }
      privy_accounts: {
        Row: {
          created_at: string
          privy_did: string
          user_id: string
        }
        Insert: {
          created_at?: string
          privy_did: string
          user_id: string
        }
        Update: {
          created_at?: string
          privy_did?: string
          user_id?: string
        }
        Relationships: []
      }
      prizes: {
        Row: {
          active: boolean
          created_at: string
          id: string
          inventory: number | null
          name: string
          onchain_index: number | null
          points: number
          rarity: string
          weight: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          inventory?: number | null
          name: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          weight?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          inventory?: number | null
          name?: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          weight?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
        }
        Relationships: []
      }
      spin_credits: {
        Row: {
          created_at: string
          created_by: string | null
          grant_id: string | null
          id: string
          kind: string
          ref: string | null
          source: string
          used_at: string | null
          used_spin_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          grant_id?: string | null
          id?: string
          kind?: string
          ref?: string | null
          source: string
          used_at?: string | null
          used_spin_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          grant_id?: string | null
          id?: string
          kind?: string
          ref?: string | null
          source?: string
          used_at?: string | null
          used_spin_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spin_credits_grant_id_fkey"
            columns: ["grant_id"]
            isOneToOne: false
            referencedRelation: "spin_grants"
            referencedColumns: ["id"]
          },
        ]
      }
      spin_grants: {
        Row: {
          count: number
          created_at: string
          created_by: string | null
          id: string
          kind: string
          note: string
          user_id: string
        }
        Insert: {
          count: number
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          note?: string
          user_id: string
        }
        Update: {
          count?: number
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          note?: string
          user_id?: string
        }
        Relationships: []
      }
      spin_purchases: {
        Row: {
          chain_id: number
          created_at: string
          id: string
          paid_at: string | null
          payer: string | null
          price_wei: number
          quantity: number
          status: string
          treasury: string
          tx_hash: string | null
          user_id: string
        }
        Insert: {
          chain_id: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payer?: string | null
          price_wei: number
          quantity: number
          status?: string
          treasury: string
          tx_hash?: string | null
          user_id: string
        }
        Update: {
          chain_id?: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payer?: string | null
          price_wei?: number
          quantity?: number
          status?: string
          treasury?: string
          tx_hash?: string | null
          user_id?: string
        }
        Relationships: []
      }
      spins: {
        Row: {
          chain_id: number | null
          contract_address: string | null
          created_at: string
          credit_id: string
          fulfilled_at: string | null
          id: string
          points: number | null
          prize_id: string | null
          prize_name: string | null
          random_word: string | null
          rarity: string | null
          request_tx: string | null
          roll: number | null
          status: string
          total_weight: number | null
          user_id: string
          vrf_request_id: string | null
        }
        Insert: {
          chain_id?: number | null
          contract_address?: string | null
          created_at?: string
          credit_id: string
          fulfilled_at?: string | null
          id?: string
          points?: number | null
          prize_id?: string | null
          prize_name?: string | null
          random_word?: string | null
          rarity?: string | null
          request_tx?: string | null
          roll?: number | null
          status?: string
          total_weight?: number | null
          user_id: string
          vrf_request_id?: string | null
        }
        Update: {
          chain_id?: number | null
          contract_address?: string | null
          created_at?: string
          credit_id?: string
          fulfilled_at?: string | null
          id?: string
          points?: number | null
          prize_id?: string | null
          prize_name?: string | null
          random_word?: string | null
          rarity?: string | null
          request_tx?: string | null
          roll?: number | null
          status?: string
          total_weight?: number | null
          user_id?: string
          vrf_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "spins_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wallet_nonces: {
        Row: {
          created_at: string
          nonce: string
          user_id: string
        }
        Insert: {
          created_at?: string
          nonce: string
          user_id: string
        }
        Update: {
          created_at?: string
          nonce?: string
          user_id?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          address: string
          id: string
          is_default: boolean
          kind: string
          user_id: string
          verified_at: string
        }
        Insert: {
          address: string
          id?: string
          is_default?: boolean
          kind?: string
          user_id: string
          verified_at?: string
        }
        Update: {
          address?: string
          id?: string
          is_default?: boolean
          kind?: string
          user_id?: string
          verified_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_grant_spins: {
        Args: {
          _actor: string
          _count: number
          _kind: string
          _note: string
          _user_id: string
        }
        Returns: string
      }
      begin_spins: {
        Args: { _count: number; _user_id: string }
        Returns: string[]
      }
      use_demo_spins: {
        Args: { _count: number; _user_id: string }
        Returns: number
      }
      complete_spin_purchase: {
        Args: { _payer: string; _purchase_id: string; _tx_hash: string }
        Returns: {
          chain_id: number
          created_at: string
          id: string
          paid_at: string | null
          payer: string | null
          price_wei: number
          quantity: number
          status: string
          treasury: string
          tx_hash: string | null
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "spin_purchases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_spin: {
        Args: {
          _prize_index: number
          _random_word: string
          _request_id: string
          _spin_id: string
        }
        Returns: {
          chain_id: number | null
          contract_address: string | null
          created_at: string
          credit_id: string
          fulfilled_at: string | null
          id: string
          points: number | null
          prize_id: string | null
          prize_name: string | null
          random_word: string | null
          rarity: string | null
          request_tx: string | null
          roll: number | null
          status: string
          total_weight: number | null
          user_id: string
          vrf_request_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "spins"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_leaderboard: {
        Args: { _limit?: number }
        Returns: {
          display_name: string
          points: number
          rank: number
          user_id: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      refund_spins: { Args: { _ids: string[] }; Returns: number }
      user_id_by_email: { Args: { _email: string }; Returns: string }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
