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
          block_hash: string | null
          block_number: number | null
          chain_id: number | null
          contract: string | null
          created_at: string
          credit_id: string | null
          evidence: Json
          from_address: string | null
          id: string
          level: number
          level_source: string | null
          log_index: number | null
          token_id: string
          tx_hash: string
          user_id: string
        }
        Insert: {
          block_hash?: string | null
          block_number?: number | null
          chain_id?: number | null
          contract?: string | null
          created_at?: string
          credit_id?: string | null
          evidence?: Json
          from_address?: string | null
          id?: string
          level: number
          level_source?: string | null
          log_index?: number | null
          token_id: string
          tx_hash: string
          user_id: string
        }
        Update: {
          block_hash?: string | null
          block_number?: number | null
          chain_id?: number | null
          contract?: string | null
          created_at?: string
          credit_id?: string | null
          evidence?: Json
          from_address?: string | null
          id?: string
          level?: number
          level_source?: string | null
          log_index?: number | null
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
      cost_entries: {
        Row: {
          amount_usd: number | null
          category: string
          created_at: string
          created_by: string | null
          id: number
          notes: string | null
          occurred_at: string
          reference: string | null
          verified: boolean
        }
        Insert: {
          amount_usd?: number | null
          category: string
          created_at?: string
          created_by?: string | null
          id?: number
          notes?: string | null
          occurred_at?: string
          reference?: string | null
          verified?: boolean
        }
        Update: {
          amount_usd?: number | null
          category?: string
          created_at?: string
          created_by?: string | null
          id?: number
          notes?: string | null
          occurred_at?: string
          reference?: string | null
          verified?: boolean
        }
        Relationships: []
      }
      draw_batches: {
        Row: {
          chain_id: number
          contract_address: string
          created_at: string
          id: string
          idempotency_key: string
          last_error: string | null
          participation_points: number
          pool_version: number
          prize_map: Json
          reconciled_at: string | null
          request_block_hash: string | null
          request_block_number: number | null
          request_confirmed_at: string | null
          request_id: number | null
          request_tx: string | null
          rule_version: number | null
          rules_hash: string | null
          season_id: string | null
          spin_count: number
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chain_id: number
          contract_address: string
          created_at?: string
          id?: string
          idempotency_key: string
          last_error?: string | null
          participation_points?: number
          pool_version: number
          prize_map: Json
          reconciled_at?: string | null
          request_block_hash?: string | null
          request_block_number?: number | null
          request_confirmed_at?: string | null
          request_id?: number | null
          request_tx?: string | null
          rule_version?: number | null
          rules_hash?: string | null
          season_id?: string | null
          spin_count: number
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chain_id?: number
          contract_address?: string
          created_at?: string
          id?: string
          idempotency_key?: string
          last_error?: string | null
          participation_points?: number
          pool_version?: number
          prize_map?: Json
          reconciled_at?: string | null
          request_block_hash?: string | null
          request_block_number?: number | null
          request_confirmed_at?: string | null
          request_id?: number | null
          request_tx?: string | null
          rule_version?: number | null
          rules_hash?: string | null
          season_id?: string | null
          spin_count?: number
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draw_batches_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      draw_coordination: {
        Row: {
          active_batch_id: string | null
          id: boolean
          pause_reason: string | null
          pool_publishing: boolean
          requests_paused: boolean
          updated_at: string
          worker_last_report: Json | null
          worker_last_run_at: string | null
        }
        Insert: {
          active_batch_id?: string | null
          id?: boolean
          pause_reason?: string | null
          pool_publishing?: boolean
          requests_paused?: boolean
          updated_at?: string
          worker_last_report?: Json | null
          worker_last_run_at?: string | null
        }
        Update: {
          active_batch_id?: string | null
          id?: boolean
          pause_reason?: string | null
          pool_publishing?: boolean
          requests_paused?: boolean
          updated_at?: string
          worker_last_report?: Json | null
          worker_last_run_at?: string | null
        }
        Relationships: []
      }
      draw_submissions: {
        Row: {
          batch_id: string
          broadcast_attempts: number
          chain_id: number
          confirmations: number | null
          contract_address: string
          created_at: string
          from_address: string
          id: string
          last_broadcast_at: string | null
          last_error: string | null
          nonce: number
          pool_version: number
          receipt_block_hash: string | null
          receipt_block_number: number | null
          signed_tx: string
          status: string
          tx_hash: string
          updated_at: string
        }
        Insert: {
          batch_id: string
          broadcast_attempts?: number
          chain_id: number
          confirmations?: number | null
          contract_address: string
          created_at?: string
          from_address: string
          id?: string
          last_broadcast_at?: string | null
          last_error?: string | null
          nonce: number
          pool_version: number
          receipt_block_hash?: string | null
          receipt_block_number?: number | null
          signed_tx: string
          status?: string
          tx_hash: string
          updated_at?: string
        }
        Update: {
          batch_id?: string
          broadcast_attempts?: number
          chain_id?: number
          confirmations?: number | null
          contract_address?: string
          created_at?: string
          from_address?: string
          id?: string
          last_broadcast_at?: string | null
          last_error?: string | null
          nonce?: number
          pool_version?: number
          receipt_block_hash?: string | null
          receipt_block_number?: number | null
          signed_tx?: string
          status?: string
          tx_hash?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "draw_submissions_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "draw_batches"
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
      funding_events: {
        Row: {
          account: string
          amount_usd: number
          created_at: string
          created_by: string
          evidence: string
          id: number
        }
        Insert: {
          account: string
          amount_usd: number
          created_at?: string
          created_by: string
          evidence: string
          id?: number
        }
        Update: {
          account?: string
          amount_usd?: number
          created_at?: string
          created_by?: string
          evidence?: string
          id?: number
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
      nft_collections: {
        Row: {
          chain_id: number
          contract: string
          created_at: string
          deploy_block: number | null
          edition: string
          id: string
          indexed_at: string | null
          indexed_through_block: number | null
          label: string
          notes: string | null
          snapshot_block: number | null
          snapshot_block_hash: string | null
          standard: string
          status: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          chain_id: number
          contract: string
          created_at?: string
          deploy_block?: number | null
          edition: string
          id?: string
          indexed_at?: string | null
          indexed_through_block?: number | null
          label: string
          notes?: string | null
          snapshot_block?: number | null
          snapshot_block_hash?: string | null
          standard?: string
          status?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          chain_id?: number
          contract?: string
          created_at?: string
          deploy_block?: number | null
          edition?: string
          id?: string
          indexed_at?: string | null
          indexed_through_block?: number | null
          label?: string
          notes?: string | null
          snapshot_block?: number | null
          snapshot_block_hash?: string | null
          standard?: string
          status?: string
          verified_at?: string | null
          verified_by?: string | null
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
      nft_snapshot_claims: {
        Row: {
          attempts: number
          chain_id: number
          collection_id: string
          contract: string
          decided_at: string | null
          edition: string
          id: string
          last_error: string | null
          ledger_id: number | null
          season_id: string
          snapshot_block: number
          status: string
          submitted_at: string
          token_id: number
          user_id: string
          verified_block_hash: string | null
          verified_owner: string | null
          wallet_address: string
        }
        Insert: {
          attempts?: number
          chain_id: number
          collection_id: string
          contract: string
          decided_at?: string | null
          edition: string
          id?: string
          last_error?: string | null
          ledger_id?: number | null
          season_id: string
          snapshot_block: number
          status?: string
          submitted_at?: string
          token_id: number
          user_id: string
          verified_block_hash?: string | null
          verified_owner?: string | null
          wallet_address: string
        }
        Update: {
          attempts?: number
          chain_id?: number
          collection_id?: string
          contract?: string
          decided_at?: string | null
          edition?: string
          id?: string
          last_error?: string | null
          ledger_id?: number | null
          season_id?: string
          snapshot_block?: number
          status?: string
          submitted_at?: string
          token_id?: number
          user_id?: string
          verified_block_hash?: string | null
          verified_owner?: string | null
          wallet_address?: string
        }
        Relationships: [
          {
            foreignKeyName: "nft_snapshot_claims_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "nft_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nft_snapshot_claims_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      nft_snapshot_owners: {
        Row: {
          collection_id: string
          last_transfer_block: number
          owner: string
          token_id: number
        }
        Insert: {
          collection_id: string
          last_transfer_block: number
          owner: string
          token_id: number
        }
        Update: {
          collection_id?: string
          last_transfer_block?: number
          owner?: string
          token_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "nft_snapshot_owners_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "nft_collections"
            referencedColumns: ["id"]
          },
        ]
      }
      operating_costs: {
        Row: {
          amount_usd: number | null
          evidence: string | null
          key: string
          updated_at: string
          updated_by: string | null
          verified: boolean
        }
        Insert: {
          amount_usd?: number | null
          evidence?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          verified?: boolean
        }
        Update: {
          amount_usd?: number | null
          evidence?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          verified?: boolean
        }
        Relationships: []
      }
      ops_alerts: {
        Row: {
          details: Json
          first_seen: string
          id: number
          kind: string
          last_seen: string
          message: string
          occurrences: number
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          subject: string
        }
        Insert: {
          details?: Json
          first_seen?: string
          id?: number
          kind: string
          last_seen?: string
          message: string
          occurrences?: number
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          subject?: string
        }
        Update: {
          details?: Json
          first_seen?: string
          id?: number
          kind?: string
          last_seen?: string
          message?: string
          occurrences?: number
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          subject?: string
        }
        Relationships: []
      }
      points_ledger: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          effective_at: string
          id: number
          metadata: Json
          reason: string
          ref: string | null
          reversal_reason: string | null
          reverses_id: number | null
          reward_subtype: string
          rule_version: number | null
          season_id: string
          source_id: string
          source_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          effective_at?: string
          id?: number
          metadata?: Json
          reason: string
          ref?: string | null
          reversal_reason?: string | null
          reverses_id?: number | null
          reward_subtype: string
          rule_version?: number | null
          season_id: string
          source_id: string
          source_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          effective_at?: string
          id?: number
          metadata?: Json
          reason?: string
          ref?: string | null
          reversal_reason?: string | null
          reverses_id?: number | null
          reward_subtype?: string
          rule_version?: number | null
          season_id?: string
          source_id?: string
          source_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "points_ledger_reverses_id_fkey"
            columns: ["reverses_id"]
            isOneToOne: false
            referencedRelation: "points_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "points_ledger_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
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
      prize_fulfillments: {
        Row: {
          created_at: string
          notes: string | null
          prize_id: string
          spin_id: string
          status: string
          unit_cost_usd: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          notes?: string | null
          prize_id: string
          spin_id: string
          status?: string
          unit_cost_usd?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          notes?: string | null
          prize_id?: string
          spin_id?: string
          status?: string
          unit_cost_usd?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "prize_fulfillments_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prize_fulfillments_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: true
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
        ]
      }
      prize_pool_publications: {
        Row: {
          chain_id: number
          contract_address: string
          error: string | null
          finished_at: string | null
          id: number
          pool_version: number | null
          remaining: Json
          started_at: string
          started_by: string | null
          status: string
          tx_hash: string | null
          weights: Json
        }
        Insert: {
          chain_id: number
          contract_address: string
          error?: string | null
          finished_at?: string | null
          id?: number
          pool_version?: number | null
          remaining: Json
          started_at?: string
          started_by?: string | null
          status?: string
          tx_hash?: string | null
          weights: Json
        }
        Update: {
          chain_id?: number
          contract_address?: string
          error?: string | null
          finished_at?: string | null
          id?: number
          pool_version?: number | null
          remaining?: Json
          started_at?: string
          started_by?: string | null
          status?: string
          tx_hash?: string | null
          weights?: Json
        }
        Relationships: []
      }
      prize_stock_events: {
        Row: {
          created_at: string
          created_by: string
          delta: number
          id: number
          prize_id: string
          published_pool_version: number | null
          reason: string
        }
        Insert: {
          created_at?: string
          created_by: string
          delta: number
          id?: number
          prize_id: string
          published_pool_version?: number | null
          reason: string
        }
        Update: {
          created_at?: string
          created_by?: string
          delta?: number
          id?: number
          prize_id?: string
          published_pool_version?: number | null
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "prize_stock_events_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
        ]
      }
      prizes: {
        Row: {
          active: boolean
          cost_verified: boolean
          created_at: string
          economics_notes: string | null
          id: string
          inventory: number | null
          kind: string
          name: string
          onchain_index: number | null
          points: number
          rarity: string
          stock_verified: boolean
          unit_cost_usd: number | null
          weight: number
        }
        Insert: {
          active?: boolean
          cost_verified?: boolean
          created_at?: string
          economics_notes?: string | null
          id?: string
          inventory?: number | null
          kind?: string
          name: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          stock_verified?: boolean
          unit_cost_usd?: number | null
          weight?: number
        }
        Update: {
          active?: boolean
          cost_verified?: boolean
          created_at?: string
          economics_notes?: string | null
          id?: string
          inventory?: number | null
          kind?: string
          name?: string
          onchain_index?: number | null
          points?: number
          rarity?: string
          stock_verified?: boolean
          unit_cost_usd?: number | null
          weight?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_key: string | null
          created_at: string
          display_name: string | null
          id: string
          public_alias: string | null
          public_id: string
          public_profile_updated_at: string | null
        }
        Insert: {
          avatar_key?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          public_alias?: string | null
          public_id?: string
          public_profile_updated_at?: string | null
        }
        Update: {
          avatar_key?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          public_alias?: string | null
          public_id?: string
          public_profile_updated_at?: string | null
        }
        Relationships: []
      }
      season_scores: {
        Row: {
          adjustment_points: number
          last_ledger_id: number | null
          nft_points: number
          participation_points: number
          prize_points: number
          season_id: string
          social_points: number
          total_points: number
          total_reached_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          adjustment_points?: number
          last_ledger_id?: number | null
          nft_points?: number
          participation_points?: number
          prize_points?: number
          season_id: string
          social_points?: number
          total_points?: number
          total_reached_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          adjustment_points?: number
          last_ledger_id?: number | null
          nft_points?: number
          participation_points?: number
          prize_points?: number
          season_id?: string
          social_points?: number
          total_points?: number
          total_reached_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "season_scores_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      season_standings: {
        Row: {
          adjustment_points: number
          nft_points: number
          participation_points: number
          prize_points: number
          public_id: string
          rank: number
          season_id: string
          social_points: number
          total_points: number
          total_reached_at: string | null
          user_id: string
          version: number
        }
        Insert: {
          adjustment_points: number
          nft_points: number
          participation_points: number
          prize_points: number
          public_id: string
          rank: number
          season_id: string
          social_points: number
          total_points: number
          total_reached_at?: string | null
          user_id: string
          version: number
        }
        Update: {
          adjustment_points?: number
          nft_points?: number
          participation_points?: number
          prize_points?: number
          public_id?: string
          rank?: number
          season_id?: string
          social_points?: number
          total_points?: number
          total_reached_at?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "season_standings_season_id_version_fkey"
            columns: ["season_id", "version"]
            isOneToOne: false
            referencedRelation: "season_standings_versions"
            referencedColumns: ["season_id", "version"]
          },
        ]
      }
      season_standings_versions: {
        Row: {
          correction_reason: string | null
          export_hash: string
          finalized_at: string
          finalized_by: string | null
          ledger_watermark: number
          row_count: number
          rules_hash: string | null
          season_id: string
          supersedes_version: number | null
          version: number
        }
        Insert: {
          correction_reason?: string | null
          export_hash: string
          finalized_at?: string
          finalized_by?: string | null
          ledger_watermark: number
          row_count: number
          rules_hash?: string | null
          season_id: string
          supersedes_version?: number | null
          version: number
        }
        Update: {
          correction_reason?: string | null
          export_hash?: string
          finalized_at?: string
          finalized_by?: string | null
          ledger_watermark?: number
          row_count?: number
          rules_hash?: string | null
          season_id?: string
          supersedes_version?: number | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "season_standings_versions_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          activated_at: string | null
          created_at: string
          created_by: string | null
          ends_at: string | null
          finalized_at: string | null
          grace_period: string
          id: string
          is_legacy: boolean
          name: string
          rules: Json
          rules_hash: string | null
          rules_version: number
          settlement_deadline: string | null
          settling_at: string | null
          slug: string
          snapshot_config: Json
          starts_at: string | null
          status: Database["public"]["Enums"]["season_status"]
          updated_at: string
        }
        Insert: {
          activated_at?: string | null
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          finalized_at?: string | null
          grace_period?: string
          id?: string
          is_legacy?: boolean
          name: string
          rules?: Json
          rules_hash?: string | null
          rules_version?: number
          settlement_deadline?: string | null
          settling_at?: string | null
          slug: string
          snapshot_config?: Json
          starts_at?: string | null
          status?: Database["public"]["Enums"]["season_status"]
          updated_at?: string
        }
        Update: {
          activated_at?: string | null
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          finalized_at?: string | null
          grace_period?: string
          id?: string
          is_legacy?: boolean
          name?: string
          rules?: Json
          rules_hash?: string | null
          rules_version?: number
          settlement_deadline?: string | null
          settling_at?: string | null
          slug?: string
          snapshot_config?: Json
          starts_at?: string | null
          status?: Database["public"]["Enums"]["season_status"]
          updated_at?: string
        }
        Relationships: []
      }
      social_award_slots: {
        Row: {
          award_day: string
          created_at: string
          share_id: string
          slot: number
          user_id: string
        }
        Insert: {
          award_day: string
          created_at?: string
          share_id: string
          slot?: number
          user_id: string
        }
        Update: {
          award_day?: string
          created_at?: string
          share_id?: string
          slot?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_award_slots_share_id_fkey"
            columns: ["share_id"]
            isOneToOne: true
            referencedRelation: "social_shares"
            referencedColumns: ["id"]
          },
        ]
      }
      social_shares: {
        Row: {
          author_handle: string | null
          author_x_user_id: string | null
          award_day: string
          decision_reason: string | null
          evidence: Json
          id: string
          ledger_id: number | null
          platform: string
          post_created_at: string | null
          post_id: string
          post_url: string
          reviewed_at: string | null
          reviewer_id: string | null
          season_id: string
          spin_id: string
          status: string
          submitted_at: string
          user_id: string
          verifier: string | null
          x_account_id: string
        }
        Insert: {
          author_handle?: string | null
          author_x_user_id?: string | null
          award_day: string
          decision_reason?: string | null
          evidence?: Json
          id?: string
          ledger_id?: number | null
          platform?: string
          post_created_at?: string | null
          post_id: string
          post_url: string
          reviewed_at?: string | null
          reviewer_id?: string | null
          season_id: string
          spin_id: string
          status?: string
          submitted_at?: string
          user_id: string
          verifier?: string | null
          x_account_id: string
        }
        Update: {
          author_handle?: string | null
          author_x_user_id?: string | null
          award_day?: string
          decision_reason?: string | null
          evidence?: Json
          id?: string
          ledger_id?: number | null
          platform?: string
          post_created_at?: string | null
          post_id?: string
          post_url?: string
          reviewed_at?: string | null
          reviewer_id?: string | null
          season_id?: string
          spin_id?: string
          status?: string
          submitted_at?: string
          user_id?: string
          verifier?: string | null
          x_account_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_shares_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_shares_spin_id_fkey"
            columns: ["spin_id"]
            isOneToOne: false
            referencedRelation: "spins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_shares_x_account_id_fkey"
            columns: ["x_account_id"]
            isOneToOne: false
            referencedRelation: "x_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_spin_slots: {
        Row: {
          created_at: string
          share_id: string
          spin_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          share_id: string
          spin_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          share_id?: string
          spin_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_spin_slots_share_id_fkey"
            columns: ["share_id"]
            isOneToOne: true
            referencedRelation: "social_shares"
            referencedColumns: ["id"]
          },
        ]
      }
      spin_credits: {
        Row: {
          created_at: string
          created_by: string | null
          funding: string
          id: string
          metadata: Json
          ref: string | null
          reserved_usd: number | null
          source: string
          used_spin_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          funding?: string
          id?: string
          metadata?: Json
          ref?: string | null
          reserved_usd?: number | null
          source: string
          used_spin_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          funding?: string
          id?: string
          metadata?: Json
          ref?: string | null
          reserved_usd?: number | null
          source?: string
          used_spin_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      spin_purchases: {
        Row: {
          ape_usd_rate: string | null
          chain_id: number
          created_at: string
          id: string
          paid_at: string | null
          payer: string | null
          price_wei: number
          quantity: number
          quoted_usd: number | null
          status: string
          treasury: string
          tx_hash: string | null
          user_id: string
        }
        Insert: {
          ape_usd_rate?: string | null
          chain_id: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payer?: string | null
          price_wei: number
          quantity: number
          quoted_usd?: number | null
          status?: string
          treasury: string
          tx_hash?: string | null
          user_id: string
        }
        Update: {
          ape_usd_rate?: string | null
          chain_id?: number
          created_at?: string
          id?: string
          paid_at?: string | null
          payer?: string | null
          price_wei?: number
          quantity?: number
          quoted_usd?: number | null
          status?: string
          treasury?: string
          tx_hash?: string | null
          user_id?: string
        }
        Relationships: []
      }
      spins: {
        Row: {
          batch_id: string | null
          batch_position: number | null
          bonus_points: number
          chain_id: number | null
          contract_address: string | null
          created_at: string
          credit_id: string
          credit_source: string | null
          fulfill_block_hash: string | null
          fulfill_block_number: number | null
          fulfilled_at: string | null
          id: string
          participation_points: number
          points: number | null
          prize_id: string | null
          prize_index: number | null
          prize_kind: string | null
          prize_name: string | null
          random_word: string | null
          rarity: string | null
          refund_reason: string | null
          request_block_hash: string | null
          request_block_number: number | null
          request_confirmed_at: string | null
          request_tx: string | null
          roll: number | null
          rule_version: number | null
          season_id: string | null
          seasonal_eligible: boolean | null
          settled_at: string | null
          status: string
          total_weight: number | null
          user_id: string
          vrf_request_id: string | null
        }
        Insert: {
          batch_id?: string | null
          batch_position?: number | null
          bonus_points?: number
          chain_id?: number | null
          contract_address?: string | null
          created_at?: string
          credit_id: string
          credit_source?: string | null
          fulfill_block_hash?: string | null
          fulfill_block_number?: number | null
          fulfilled_at?: string | null
          id?: string
          participation_points?: number
          points?: number | null
          prize_id?: string | null
          prize_index?: number | null
          prize_kind?: string | null
          prize_name?: string | null
          random_word?: string | null
          rarity?: string | null
          refund_reason?: string | null
          request_block_hash?: string | null
          request_block_number?: number | null
          request_confirmed_at?: string | null
          request_tx?: string | null
          roll?: number | null
          rule_version?: number | null
          season_id?: string | null
          seasonal_eligible?: boolean | null
          settled_at?: string | null
          status?: string
          total_weight?: number | null
          user_id: string
          vrf_request_id?: string | null
        }
        Update: {
          batch_id?: string | null
          batch_position?: number | null
          bonus_points?: number
          chain_id?: number | null
          contract_address?: string | null
          created_at?: string
          credit_id?: string
          credit_source?: string | null
          fulfill_block_hash?: string | null
          fulfill_block_number?: number | null
          fulfilled_at?: string | null
          id?: string
          participation_points?: number
          points?: number | null
          prize_id?: string | null
          prize_index?: number | null
          prize_kind?: string | null
          prize_name?: string | null
          random_word?: string | null
          rarity?: string | null
          refund_reason?: string | null
          request_block_hash?: string | null
          request_block_number?: number | null
          request_confirmed_at?: string | null
          request_tx?: string | null
          roll?: number | null
          rule_version?: number | null
          season_id?: string | null
          seasonal_eligible?: boolean | null
          settled_at?: string | null
          status?: string
          total_weight?: number | null
          user_id?: string
          vrf_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "spins_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "draw_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_prize_id_fkey"
            columns: ["prize_id"]
            isOneToOne: false
            referencedRelation: "prizes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "spins_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      sponsored_budgets: {
        Row: {
          committed_usd: number
          low_water_usd: number
          pause_reason: string | null
          paused: boolean
          source: string
          updated_at: string
        }
        Insert: {
          committed_usd?: number
          low_water_usd?: number
          pause_reason?: string | null
          paused?: boolean
          source: string
          updated_at?: string
        }
        Update: {
          committed_usd?: number
          low_water_usd?: number
          pause_reason?: string | null
          paused?: boolean
          source?: string
          updated_at?: string
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
      wallet_challenges: {
        Row: {
          address: string
          chain_id: number
          consumed_at: string | null
          domain: string
          expires_at: string
          issued_at: string
          message: string
          nonce: string
          uri: string
          user_id: string
        }
        Insert: {
          address: string
          chain_id: number
          consumed_at?: string | null
          domain: string
          expires_at: string
          issued_at?: string
          message: string
          nonce: string
          uri: string
          user_id: string
        }
        Update: {
          address?: string
          chain_id?: number
          consumed_at?: string | null
          domain?: string
          expires_at?: string
          issued_at?: string
          message?: string
          nonce?: string
          uri?: string
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
          is_contract: boolean
          is_default: boolean
          kind: string
          user_id: string
          verification_method: string | null
          verified_at: string
          verified_chain_id: number | null
        }
        Insert: {
          address: string
          id?: string
          is_contract?: boolean
          is_default?: boolean
          kind?: string
          user_id: string
          verification_method?: string | null
          verified_at?: string
          verified_chain_id?: number | null
        }
        Update: {
          address?: string
          id?: string
          is_contract?: boolean
          is_default?: boolean
          kind?: string
          user_id?: string
          verification_method?: string | null
          verified_at?: string
          verified_chain_id?: number | null
        }
        Relationships: []
      }
      x_accounts: {
        Row: {
          handle: string
          id: string
          linked_at: string
          unlinked_at: string | null
          user_id: string
          verification_method: string
          verified_at: string | null
          x_user_id: string | null
        }
        Insert: {
          handle: string
          id?: string
          linked_at?: string
          unlinked_at?: string | null
          user_id: string
          verification_method: string
          verified_at?: string | null
          x_user_id?: string | null
        }
        Update: {
          handle?: string
          id?: string
          linked_at?: string
          unlinked_at?: string | null
          user_id?: string
          verification_method?: string
          verified_at?: string | null
          x_user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_season: {
        Args: { _season: string; _actor: string }
        Returns: {
          activated_at: string | null
          created_at: string
          created_by: string | null
          ends_at: string | null
          finalized_at: string | null
          grace_period: string
          id: string
          is_legacy: boolean
          name: string
          rules: Json
          rules_hash: string | null
          rules_version: number
          settlement_deadline: string | null
          settling_at: string | null
          slug: string
          snapshot_config: Json
          starts_at: string | null
          status: Database["public"]["Enums"]["season_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "seasons"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      adjust_prize_stock: {
        Args: { _prize: string; _delta: number; _reason: string; _actor: string }
        Returns: number
      }
      admin_adjust_points: {
        Args: { _season: string; _user: string; _amount: number; _reason: string; _actor: string }
        Returns: number
      }
      advance_seasons: {
        Args: never
        Returns: number
      }
      apply_season_backfill: {
        Args: { _season: string; _actor: string }
        Returns: Json
      }
      begin_pool_publication: {
        Args: { _chain_id: number; _contract: string; _chain_remaining: Json; _actor: string }
        Returns: Json
      }
      complete_spin_purchase: {
        Args: { _purchase_id: string; _tx_hash: string; _payer: string }
        Returns: {
          ape_usd_rate: string | null
          chain_id: number
          created_at: string
          id: string
          paid_at: string | null
          payer: string | null
          price_wei: number
          quantity: number
          quoted_usd: number | null
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
      confirm_draw_request: {
        Args: { _tx_hash: string; _request_id: number; _block_number: number; _block_hash: string; _block_time: string; _confirmations: number; _event_spin_ids: string[] }
        Returns: string
      }
      consume_wallet_challenge: {
        Args: { _nonce: string; _user: string }
        Returns: {
          address: string
          chain_id: number
          consumed_at: string | null
          domain: string
          expires_at: string
          issued_at: string
          message: string
          nonce: string
          uri: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "wallet_challenges"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      correct_finalized_season: {
        Args: { _season: string; _actor: string; _reason: string; _ops: Json }
        Returns: Json
      }
      current_season: {
        Args: never
        Returns: {
          activated_at: string | null
          created_at: string
          created_by: string | null
          ends_at: string | null
          finalized_at: string | null
          grace_period: string
          id: string
          is_legacy: boolean
          name: string
          rules: Json
          rules_hash: string | null
          rules_version: number
          settlement_deadline: string | null
          settling_at: string | null
          slug: string
          snapshot_config: Json
          starts_at: string | null
          status: Database["public"]["Enums"]["season_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "seasons"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      default_season_rules: {
        Args: never
        Returns: Json
      }
      draw_cost_estimate: {
        Args: never
        Returns: Json
      }
      economics_status: {
        Args: never
        Returns: Json
      }
      finalize_season: {
        Args: { _season: string; _actor: string }
        Returns: Json
      }
      finish_pool_publication: {
        Args: { _publication: number; _ok: boolean; _tx_hash: string; _pool_version: number; _error: string }
        Returns: undefined
      }
      funding_balance: {
        Args: { _account: string }
        Returns: number
      }
      get_leaderboard: {
        Args: { _limit?: number }
        Returns: {
          rank: number
          public_id: string
          display_name: string
          avatar_key: string
          points: string
        }[]
      }
      get_my_season_standing: {
        Args: { _slug: string }
        Returns: {
          rank: number
          total_points: string
          nft_points: string
          participation_points: string
          prize_points: string
          social_points: string
          adjustment_points: string
          total_reached_at: string
          players: number
        }[]
      }
      get_public_seasons: {
        Args: never
        Returns: {
          id: string
          slug: string
          name: string
          status: Database["public"]["Enums"]["season_status"]
          is_legacy: boolean
          starts_at: string
          ends_at: string
          settlement_deadline: string
          grace_hours: number
          rules: Json
          rules_version: number
          rules_hash: string
          standings_version: number
          standings_export_hash: string
          finalized_at: string
        }[]
      }
      get_season_leaderboard: {
        Args: { _slug: string; _offset?: number; _limit?: number }
        Returns: {
          rank: number
          public_id: string
          alias: string
          avatar_key: string
          total_points: string
          nft_points: string
          participation_points: string
          prize_points: string
          social_points: string
          adjustment_points: string
          total_reached_at: string
          total_count: number
          standings_version: number
        }[]
      }
      has_role: {
        Args: { _user_id: string; _role: Database["public"]["Enums"]["app_role"] }
        Returns: boolean
      }
      is_admin: {
        Args: never
        Returns: boolean
      }
      issue_sponsored_credits: {
        Args: { _user: string; _source: string; _count: number; _ref: string; _actor: string; _metadata?: Json }
        Returns: string[]
      }
      ledger_award: {
        Args: { _season: string; _user: string; _source_type: string; _source_id: string; _subtype: string; _amount: number; _rule_version: number; _effective_at: string; _metadata?: Json; _actor?: string }
        Returns: number
      }
      ledger_category: {
        Args: { _subtype: string }
        Returns: string
      }
      link_verified_wallet: {
        Args: { _user: string; _address: string; _kind: string; _method: string; _chain_id: number; _is_contract: boolean }
        Returns: {
          address: string
          id: string
          is_contract: boolean
          is_default: boolean
          kind: string
          user_id: string
          verification_method: string | null
          verified_at: string
          verified_chain_id: number | null
        }
        SetofOptions: {
          from: "*"
          to: "wallets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      link_x_account: {
        Args: { _user: string; _handle: string; _x_user_id: string; _method: string }
        Returns: {
          handle: string
          id: string
          linked_at: string
          unlinked_at: string | null
          user_id: string
          verification_method: string
          verified_at: string | null
          x_user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "x_accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      normalize_x_post_url: {
        Args: { _url: string }
        Returns: string
      }
      prize_pool_issues: {
        Args: never
        Returns: {
          prize_id: string
          prize_name: string
          issue: string
        }[]
      }
      raise_alert: {
        Args: { _kind: string; _subject: string; _severity: string; _message: string; _details?: Json }
        Returns: number
      }
      record_burn_claim: {
        Args: { _user: string; _chain_id: number; _contract: string; _token_id: string; _tx_hash: string; _log_index: number; _block_number: number; _block_hash: string; _from: string; _level: number; _level_source: string; _evidence: Json }
        Returns: Json
      }
      record_draw_broadcast: {
        Args: { _tx_hash: string; _error: string }
        Returns: undefined
      }
      record_draw_failed: {
        Args: { _tx_hash: string; _outcome: string; _block_number: number; _block_hash: string; _evidence: Json }
        Returns: number
      }
      record_draw_signed: {
        Args: { _batch: string; _from: string; _nonce: number; _tx_hash: string; _signed_tx: string }
        Returns: string
      }
      record_snapshot_verification: {
        Args: { _claim: string; _owner: string; _block_hash: string; _unavailable: boolean; _error: string }
        Returns: {
          attempts: number
          chain_id: number
          collection_id: string
          contract: string
          decided_at: string | null
          edition: string
          id: string
          last_error: string | null
          ledger_id: number | null
          season_id: string
          snapshot_block: number
          status: string
          submitted_at: string
          token_id: number
          user_id: string
          verified_block_hash: string | null
          verified_owner: string | null
          wallet_address: string
        }
        SetofOptions: {
          from: "*"
          to: "nft_snapshot_claims"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      refund_batch: {
        Args: { _batch: string; _status: string; _reason: string }
        Returns: number
      }
      release_draw_prebroadcast: {
        Args: { _batch: string; _reason: string }
        Returns: number
      }
      reserve_draw_batch: {
        Args: { _user: string; _count: number; _idempotency_key: string; _chain_id: number; _contract: string; _pool_version: number }
        Returns: Json
      }
      resolve_alert: {
        Args: { _kind: string; _subject: string; _actor?: string }
        Returns: number
      }
      reverse_ledger_entry: {
        Args: { _ledger_id: number; _amount: number; _reason: string; _actor: string }
        Returns: number
      }
      review_social_share: {
        Args: { _share: string; _approve: boolean; _verifier: string; _reviewer: string; _author_x_user_id: string; _author_handle: string; _post_created_at: string; _references_spin: boolean; _evidence: Json; _reason: string }
        Returns: {
          author_handle: string | null
          author_x_user_id: string | null
          award_day: string
          decision_reason: string | null
          evidence: Json
          id: string
          ledger_id: number | null
          platform: string
          post_created_at: string | null
          post_id: string
          post_url: string
          reviewed_at: string | null
          reviewer_id: string | null
          season_id: string
          spin_id: string
          status: string
          submitted_at: string
          user_id: string
          verifier: string | null
          x_account_id: string
        }
        SetofOptions: {
          from: "*"
          to: "social_shares"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      run_db_monitors: {
        Args: never
        Returns: Json
      }
      score_reached_at: {
        Args: { _season: string; _user: string }
        Returns: string
      }
      season_activation_errors: {
        Args: { _season: string }
        Returns: string[]
      }
      season_backfill_report: {
        Args: { _season: string }
        Returns: Json
      }
      season_ranking: {
        Args: { _season: string }
        Returns: {
          rank: number
          user_id: string
          total_points: number
          nft_points: number
          participation_points: number
          prize_points: number
          social_points: number
          adjustment_points: number
          total_reached_at: string
        }[]
      }
      season_rules_errors: {
        Args: { _rules: Json }
        Returns: string[]
      }
      season_unresolved: {
        Args: { _season: string }
        Returns: Json
      }
      set_public_profile: {
        Args: { _user: string; _alias: string; _avatar: string }
        Returns: {
          avatar_key: string | null
          created_at: string
          display_name: string | null
          id: string
          public_alias: string | null
          public_id: string
          public_profile_updated_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "profiles"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      settle_drawn_spin: {
        Args: { _spin: string; _prize_index: number; _random_word: string; _request_id: number; _fulfill_block: number; _fulfill_block_hash: string }
        Returns: {
          batch_id: string | null
          batch_position: number | null
          bonus_points: number
          chain_id: number | null
          contract_address: string | null
          created_at: string
          credit_id: string
          credit_source: string | null
          fulfill_block_hash: string | null
          fulfill_block_number: number | null
          fulfilled_at: string | null
          id: string
          participation_points: number
          points: number | null
          prize_id: string | null
          prize_index: number | null
          prize_kind: string | null
          prize_name: string | null
          random_word: string | null
          rarity: string | null
          refund_reason: string | null
          request_block_hash: string | null
          request_block_number: number | null
          request_confirmed_at: string | null
          request_tx: string | null
          roll: number | null
          rule_version: number | null
          season_id: string | null
          seasonal_eligible: boolean | null
          settled_at: string | null
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
      submit_snapshot_claims: {
        Args: { _user: string; _collection: string; _tokens: Json }
        Returns: Json
      }
      submit_social_share: {
        Args: { _user: string; _post_url: string; _spin: string; _verifier: string }
        Returns: {
          author_handle: string | null
          author_x_user_id: string | null
          award_day: string
          decision_reason: string | null
          evidence: Json
          id: string
          ledger_id: number | null
          platform: string
          post_created_at: string | null
          post_id: string
          post_url: string
          reviewed_at: string | null
          reviewer_id: string | null
          season_id: string
          spin_id: string
          status: string
          submitted_at: string
          user_id: string
          verifier: string | null
          x_account_id: string
        }
        SetofOptions: {
          from: "*"
          to: "social_shares"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      user_id_by_email: {
        Args: { _email: string }
        Returns: string
      }
      write_season_standings: {
        Args: { _season: string; _actor: string; _supersedes: number; _reason: string }
        Returns: number
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      season_status: "draft" | "active" | "settling" | "finalized"
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
      season_status: ["draft", "active", "settling", "finalized"],
    },
  },
} as const
