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
    PostgrestVersion: "14.17"
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
      demo_spins: {
        Row: {
          created_at: string
          id: string
          points: number
          prize_id: string | null
          prize_name: string
          rarity: string
          source: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          points?: number
          prize_id?: string | null
          prize_name: string
          rarity: string
          source: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          points?: number
          prize_id?: string | null
          prize_name?: string
          rarity?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "demo_spins_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
        ]
      }
      event_knowledge: {
        Row: {
          content: string
          fetched_at: string
          source: string
          title: string | null
          url: string
        }
        Insert: {
          content: string
          fetched_at?: string
          source?: string
          title?: string | null
          url: string
        }
        Update: {
          content?: string
          fetched_at?: string
          source?: string
          title?: string | null
          url?: string
        }
        Relationships: []
      }
      gift_certificates: {
        Row: {
          ape_usd_rate: string | null
          ape_wei: string | null
          created_at: string
          forwarded_at: string | null
          forwarded_by: string | null
          id: string
          issuer_wallet: string | null
          paid_at: string | null
          pay_tx: string | null
          payout_wallet: string | null
          pending_tx: string | null
          prize_id: string | null
          prize_name: string
          quoted_at: string | null
          redeem_code: string | null
          redeemed_at: string | null
          requested_at: string | null
          spin_id: string
          status: string
          updated_at: string
          user_id: string
          value_usd: number
          vendor_id: string | null
        }
        Insert: {
          ape_usd_rate?: string | null
          ape_wei?: string | null
          created_at?: string
          forwarded_at?: string | null
          forwarded_by?: string | null
          id?: string
          issuer_wallet?: string | null
          paid_at?: string | null
          pay_tx?: string | null
          payout_wallet?: string | null
          pending_tx?: string | null
          prize_id?: string | null
          prize_name: string
          quoted_at?: string | null
          redeem_code?: string | null
          redeemed_at?: string | null
          requested_at?: string | null
          spin_id: string
          status?: string
          updated_at?: string
          user_id: string
          value_usd: number
          vendor_id?: string | null
        }
        Update: {
          ape_usd_rate?: string | null
          ape_wei?: string | null
          created_at?: string
          forwarded_at?: string | null
          forwarded_by?: string | null
          id?: string
          issuer_wallet?: string | null
          paid_at?: string | null
          pay_tx?: string | null
          payout_wallet?: string | null
          pending_tx?: string | null
          prize_id?: string | null
          prize_name?: string
          quoted_at?: string | null
          redeem_code?: string | null
          redeemed_at?: string | null
          requested_at?: string | null
          spin_id?: string
          status?: string
          updated_at?: string
          user_id?: string
          value_usd?: number
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gift_certificates_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_certificates_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: true
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
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
      prize_claims: {
        Row: {
          address: Json | null
          admin_note: string | null
          created_at: string
          delivery: string
          email: string
          full_name: string
          id: string
          notes: string | null
          phone: string | null
          prize_id: string | null
          prize_name: string
          ship_ape_rate: string | null
          ship_ape_wei: string | null
          ship_carrier: string | null
          ship_days: number | null
          ship_paid_at: string | null
          ship_pay_tx: string | null
          ship_payer: string | null
          ship_pending_tx: string | null
          ship_quote_id: string | null
          ship_quoted_at: string | null
          ship_rate_id: string | null
          ship_service: string | null
          ship_usd: number | null
          spin_id: string
          status: string
          tracking: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: Json | null
          admin_note?: string | null
          created_at?: string
          delivery: string
          email: string
          full_name: string
          id?: string
          notes?: string | null
          phone?: string | null
          prize_id?: string | null
          prize_name: string
          ship_ape_rate?: string | null
          ship_ape_wei?: string | null
          ship_carrier?: string | null
          ship_days?: number | null
          ship_paid_at?: string | null
          ship_pay_tx?: string | null
          ship_payer?: string | null
          ship_pending_tx?: string | null
          ship_quote_id?: string | null
          ship_quoted_at?: string | null
          ship_rate_id?: string | null
          ship_service?: string | null
          ship_usd?: number | null
          spin_id: string
          status?: string
          tracking?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: Json | null
          admin_note?: string | null
          created_at?: string
          delivery?: string
          email?: string
          full_name?: string
          id?: string
          notes?: string | null
          phone?: string | null
          prize_id?: string | null
          prize_name?: string
          ship_ape_rate?: string | null
          ship_ape_wei?: string | null
          ship_carrier?: string | null
          ship_days?: number | null
          ship_paid_at?: string | null
          ship_pay_tx?: string | null
          ship_payer?: string | null
          ship_pending_tx?: string | null
          ship_quote_id?: string | null
          ship_quoted_at?: string | null
          ship_rate_id?: string | null
          ship_service?: string | null
          ship_usd?: number | null
          spin_id?: string
          status?: string
          tracking?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prize_claims_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prize_claims_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: true
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
      }
      prizes: {
        Row: {
          active: boolean
          cert_issuer_wallet: string | null
          cert_value_usd: number | null
          cert_vendor_id: string | null
          created_at: string
          id: string
          image_url: string | null
          inventory: number | null
          is_physical: boolean
          name: string
          onchain_index: number | null
          points: number
          rarity: string
          ship_height_in: number | null
          ship_length_in: number | null
          ship_weight_oz: number | null
          ship_width_in: number | null
          stock_token_ids: string[] | null
          stocked: number | null
          weight: number
        }
        Insert: {
          active?: boolean
          cert_issuer_wallet?: string | null
          cert_value_usd?: number | null
          cert_vendor_id?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          inventory?: number | null
          is_physical?: boolean
          name: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          ship_height_in?: number | null
          ship_length_in?: number | null
          ship_weight_oz?: number | null
          ship_width_in?: number | null
          stock_token_ids?: string[] | null
          stocked?: number | null
          weight?: number
        }
        Update: {
          active?: boolean
          cert_issuer_wallet?: string | null
          cert_value_usd?: number | null
          cert_vendor_id?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          inventory?: number | null
          is_physical?: boolean
          name?: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          ship_height_in?: number | null
          ship_length_in?: number | null
          ship_weight_oz?: number | null
          ship_width_in?: number | null
          stock_token_ids?: string[] | null
          stocked?: number | null
          weight?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      shipping_quotes: {
        Row: {
          address: Json
          created_at: string
          id: string
          rates: Json
          spin_id: string
          user_id: string
        }
        Insert: {
          address: Json
          created_at?: string
          id?: string
          rates: Json
          spin_id: string
          user_id: string
        }
        Update: {
          address?: Json
          created_at?: string
          id?: string
          rates?: Json
          spin_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipping_quotes_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: false
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
      }
      spin_code_redemptions: {
        Row: {
          code_id: string
          created_at: string
          grant_id: string | null
          id: string
          user_id: string
        }
        Insert: {
          code_id: string
          created_at?: string
          grant_id?: string | null
          id?: string
          user_id: string
        }
        Update: {
          code_id?: string
          created_at?: string
          grant_id?: string | null
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spin_code_redemptions_code_id_fkey"
            columns: ["code_id"]
            isOneToOne: false
            referencedRelation: "spin_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      spin_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          disabled: boolean
          expires_at: string
          id: string
          kind: string
          max_redemptions: number | null
          note: string
          spins: number
          starts_at: string
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          disabled?: boolean
          expires_at: string
          id?: string
          kind?: string
          max_redemptions?: number | null
          note?: string
          spins?: number
          starts_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          disabled?: boolean
          expires_at?: string
          id?: string
          kind?: string
          max_redemptions?: number | null
          note?: string
          spins?: number
          starts_at?: string
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
          delivered_at: string | null
          delivered_by: string | null
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
          delivered_at?: string | null
          delivered_by?: string | null
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
          delivered_at?: string | null
          delivered_by?: string | null
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
      stock_certificates: {
        Row: {
          chain_id: number | null
          claim_rand: string | null
          contract: string | null
          created_at: string
          delivery: string | null
          email: string | null
          emailed_at: string | null
          error: string | null
          id: string
          prize_id: string | null
          prize_name: string
          send_started_at: string | null
          sent_at: string | null
          spin_id: string
          status: string
          to_wallet: string | null
          token_id: string | null
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          chain_id?: number | null
          claim_rand?: string | null
          contract?: string | null
          created_at?: string
          delivery?: string | null
          email?: string | null
          emailed_at?: string | null
          error?: string | null
          id?: string
          prize_id?: string | null
          prize_name: string
          send_started_at?: string | null
          sent_at?: string | null
          spin_id: string
          status?: string
          to_wallet?: string | null
          token_id?: string | null
          tx_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          chain_id?: number | null
          claim_rand?: string | null
          contract?: string | null
          created_at?: string
          delivery?: string | null
          email?: string | null
          emailed_at?: string | null
          error?: string | null
          id?: string
          prize_id?: string | null
          prize_name?: string
          send_started_at?: string | null
          sent_at?: string | null
          spin_id?: string
          status?: string
          to_wallet?: string | null
          token_id?: string | null
          tx_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_certificates_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_certificates_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: true
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
      }
      super_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      treasury_alerts: {
        Row: {
          acknowledged_at: string | null
          created_at: string
          id: string
          job_id: string | null
          level: string
          message: string
        }
        Insert: {
          acknowledged_at?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          level?: string
          message: string
        }
        Update: {
          acknowledged_at?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          level?: string
          message?: string
        }
        Relationships: []
      }
      treasury_events: {
        Row: {
          address: string | null
          amount_wei: string | null
          block_number: number
          block_time: string | null
          bucket: number | null
          chain_id: number
          id: number
          log_index: number
          name: string
          splitter: string
          target_wei: string | null
          tx_hash: string
        }
        Insert: {
          address?: string | null
          amount_wei?: string | null
          block_number: number
          block_time?: string | null
          bucket?: number | null
          chain_id: number
          id?: number
          log_index: number
          name: string
          splitter: string
          target_wei?: string | null
          tx_hash: string
        }
        Update: {
          address?: string | null
          amount_wei?: string | null
          block_number?: number
          block_time?: string | null
          bucket?: number | null
          chain_id?: number
          id?: number
          log_index?: number
          name?: string
          splitter?: string
          target_wei?: string | null
          tx_hash?: string
        }
        Relationships: []
      }
      treasury_jobs: {
        Row: {
          attempts: number
          bridge_expected_wei: string | null
          bridge_tx: string | null
          bucket: number
          buy_tx: string | null
          chain_id: number
          created_at: string
          deliver_tx: string | null
          dest_chain_id: number | null
          error: string | null
          id: string
          last_ok_status: string | null
          listing_hash: string | null
          manual: boolean
          nft_contract: string | null
          note: string | null
          price_wei: string | null
          relay_request_id: string | null
          release_from_block: number | null
          release_tx: string | null
          released_ape_wei: string | null
          splitter: string
          status: string
          token_id: string | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          bridge_expected_wei?: string | null
          bridge_tx?: string | null
          bucket: number
          buy_tx?: string | null
          chain_id: number
          created_at?: string
          deliver_tx?: string | null
          dest_chain_id?: number | null
          error?: string | null
          id?: string
          last_ok_status?: string | null
          listing_hash?: string | null
          manual?: boolean
          nft_contract?: string | null
          note?: string | null
          price_wei?: string | null
          relay_request_id?: string | null
          release_from_block?: number | null
          release_tx?: string | null
          released_ape_wei?: string | null
          splitter: string
          status: string
          token_id?: string | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          bridge_expected_wei?: string | null
          bridge_tx?: string | null
          bucket?: number
          buy_tx?: string | null
          chain_id?: number
          created_at?: string
          deliver_tx?: string | null
          dest_chain_id?: number | null
          error?: string | null
          id?: string
          last_ok_status?: string | null
          listing_hash?: string | null
          manual?: boolean
          nft_contract?: string | null
          note?: string | null
          price_wei?: string | null
          relay_request_id?: string | null
          release_from_block?: number | null
          release_tx?: string | null
          released_ape_wei?: string | null
          splitter?: string
          status?: string
          token_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      treasury_lock: {
        Row: {
          id: number
          last_run_at: string | null
          locked_until: string | null
        }
        Insert: {
          id: number
          last_run_at?: string | null
          locked_until?: string | null
        }
        Update: {
          id?: number
          last_run_at?: string | null
          locked_until?: string | null
        }
        Relationships: []
      }
      treasury_runs: {
        Row: {
          dry_run: boolean
          finished_at: string | null
          id: string
          log: Json
          ok: boolean | null
          started_at: string
          trigger: string
        }
        Insert: {
          dry_run?: boolean
          finished_at?: string | null
          id?: string
          log?: Json
          ok?: boolean | null
          started_at?: string
          trigger?: string
        }
        Update: {
          dry_run?: boolean
          finished_at?: string | null
          id?: string
          log?: Json
          ok?: boolean | null
          started_at?: string
          trigger?: string
        }
        Relationships: []
      }
      treasury_splitters: {
        Row: {
          address: string
          block_number: number | null
          chain_id: number
          constructor_args: string
          created_at: string
          deployed_by: string | null
          id: string
          is_active: boolean
          keeper: string
          owner: string
          recipients: Json
          scanned_block: number | null
          tx_hash: string
        }
        Insert: {
          address: string
          block_number?: number | null
          chain_id: number
          constructor_args: string
          created_at?: string
          deployed_by?: string | null
          id?: string
          is_active?: boolean
          keeper: string
          owner: string
          recipients: Json
          scanned_block?: number | null
          tx_hash: string
        }
        Update: {
          address?: string
          block_number?: number | null
          chain_id?: number
          constructor_args?: string
          created_at?: string
          deployed_by?: string | null
          id?: string
          is_active?: boolean
          keeper?: string
          owner?: string
          recipients?: Json
          scanned_block?: number | null
          tx_hash?: string
        }
        Relationships: []
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
      vendors: {
        Row: {
          business_name: string
          created_at: string
          created_by: string | null
          location: string | null
          updated_at: string
          user_id: string
          wallet: string | null
        }
        Insert: {
          business_name: string
          created_at?: string
          created_by?: string | null
          location?: string | null
          updated_at?: string
          user_id: string
          wallet?: string | null
        }
        Update: {
          business_name?: string
          created_at?: string
          created_by?: string | null
          location?: string | null
          updated_at?: string
          user_id?: string
          wallet?: string | null
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
      admin_delete_grant: {
        Args: { _actor: string; _grant_id: string }
        Returns: number
      }
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
      can_view_prize_image: { Args: { _name: string }; Returns: boolean }
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
          delivered_at: string | null
          delivered_by: string | null
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
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      leaderboard_mode: { Args: never; Returns: string }
      redeem_spin_code: {
        Args: { _code: string; _user_id: string }
        Returns: Json
      }
      refund_spins: { Args: { _ids: string[] }; Returns: number }
      treasury_try_lock: {
        Args: {
          _force: boolean
          _hold_seconds: number
          _min_gap_seconds: number
        }
        Returns: boolean
      }
      treasury_unlock: { Args: never; Returns: undefined }
      use_demo_spins: {
        Args: { _count: number; _user_id: string }
        Returns: number
      }
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
