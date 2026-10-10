export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      app_config: {
        Row: {
          key: string;
          updated_at: string;
          updated_by: string | null;
          value: Json;
          version: number;
        };
        Insert: {
          key: string;
          updated_at?: string;
          updated_by?: string | null;
          value: Json;
          version?: number;
        };
        Update: {
          key?: string;
          updated_at?: string;
          updated_by?: string | null;
          value?: Json;
          version?: number;
        };
        Relationships: [];
      };
      app_config_history: {
        Row: {
          changed_at: string;
          changed_by: string | null;
          id: number;
          key: string;
          value: Json;
          version: number;
        };
        Insert: {
          changed_at?: string;
          changed_by?: string | null;
          id?: number;
          key: string;
          value: Json;
          version: number;
        };
        Update: {
          changed_at?: string;
          changed_by?: string | null;
          id?: number;
          key?: string;
          value?: Json;
          version?: number;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          action: string;
          actor: string | null;
          created_at: string;
          details: Json | null;
          id: number;
        };
        Insert: {
          action: string;
          actor?: string | null;
          created_at?: string;
          details?: Json | null;
          id?: number;
        };
        Update: {
          action?: string;
          actor?: string | null;
          created_at?: string;
          details?: Json | null;
          id?: number;
        };
        Relationships: [];
      };
      burn_claims: {
        Row: {
          block_hash: string | null;
          block_number: number | null;
          chain_id: number;
          confirmations: number | null;
          contract: string;
          created_at: string;
          credit_id: string | null;
          evidence: Json;
          from_address: string | null;
          id: string;
          level: number;
          level_source: string | null;
          log_index: number | null;
          to_address: string | null;
          token_id: string;
          tx_hash: string;
          user_id: string;
        };
        Insert: {
          block_hash?: string | null;
          block_number?: number | null;
          chain_id: number;
          confirmations?: number | null;
          contract: string;
          created_at?: string;
          credit_id?: string | null;
          evidence?: Json;
          from_address?: string | null;
          id?: string;
          level: number;
          level_source?: string | null;
          log_index?: number | null;
          to_address?: string | null;
          token_id: string;
          tx_hash: string;
          user_id: string;
        };
        Update: {
          block_hash?: string | null;
          block_number?: number | null;
          chain_id?: number;
          confirmations?: number | null;
          contract?: string;
          created_at?: string;
          credit_id?: string | null;
          evidence?: Json;
          from_address?: string | null;
          id?: string;
          level?: number;
          level_source?: string | null;
          log_index?: number | null;
          to_address?: string | null;
          token_id?: string;
          tx_hash?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      contact_messages: {
        Row: {
          created_at: string;
          email: string;
          id: string;
          message: string;
          name: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          email: string;
          id?: string;
          message: string;
          name: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          email?: string;
          id?: string;
          message?: string;
          name?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      draw_batches: {
        Row: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          chain_id: number;
          contract_address: string;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          last_error?: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at?: string | null;
          refund_reason?: string | null;
          request_block?: number | null;
          request_block_hash?: string | null;
          request_block_time?: string | null;
          request_confirmations?: number | null;
          request_id?: string | null;
          request_tx?: string | null;
          rule_version_id?: string | null;
          season_id?: string | null;
          spin_count: number;
          spin_ids: string[];
          status?: string;
          submission_claimed_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          chain_id?: number;
          contract_address?: string;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          last_error?: string | null;
          pool_version?: number;
          prize_map?: Json;
          reconciled_at?: string | null;
          refund_reason?: string | null;
          request_block?: number | null;
          request_block_hash?: string | null;
          request_block_time?: string | null;
          request_confirmations?: number | null;
          request_id?: string | null;
          request_tx?: string | null;
          rule_version_id?: string | null;
          season_id?: string | null;
          spin_count?: number;
          spin_ids?: string[];
          status?: string;
          submission_claimed_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "draw_batches_rule_version_id_fkey";
            columns: ["rule_version_id"];
            isOneToOne: false;
            referencedRelation: "season_rule_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "draw_batches_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      draw_submissions: {
        Row: {
          batch_id: string;
          block_hash: string | null;
          block_number: number | null;
          broadcast_attempts: number;
          chain_id: number;
          created_at: string;
          id: string;
          last_broadcast_at: string | null;
          last_error: string | null;
          nonce: number;
          operator_address: string;
          raw_tx: string;
          status: string;
          tx_hash: string;
        };
        Insert: {
          batch_id: string;
          block_hash?: string | null;
          block_number?: number | null;
          broadcast_attempts?: number;
          chain_id: number;
          created_at?: string;
          id?: string;
          last_broadcast_at?: string | null;
          last_error?: string | null;
          nonce: number;
          operator_address: string;
          raw_tx: string;
          status?: string;
          tx_hash: string;
        };
        Update: {
          batch_id?: string;
          block_hash?: string | null;
          block_number?: number | null;
          broadcast_attempts?: number;
          chain_id?: number;
          created_at?: string;
          id?: string;
          last_broadcast_at?: string | null;
          last_error?: string | null;
          nonce?: number;
          operator_address?: string;
          raw_tx?: string;
          status?: string;
          tx_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "draw_submissions_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "draw_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      event_knowledge: {
        Row: {
          content: string;
          fetched_at: string;
          source: string;
          title: string | null;
          url: string;
        };
        Insert: {
          content: string;
          fetched_at?: string;
          source?: string;
          title?: string | null;
          url: string;
        };
        Update: {
          content?: string;
          fetched_at?: string;
          source?: string;
          title?: string | null;
          url?: string;
        };
        Relationships: [];
      };
      final_standings: {
        Row: {
          adjustment_points: number;
          legacy_points: number;
          nft_points: number;
          participation_points: number;
          prize_points: number;
          public_id: string;
          rank: number;
          social_points: number;
          total: number;
          total_reached_at: string | null;
          user_id: string;
          version_id: string;
        };
        Insert: {
          adjustment_points: number;
          legacy_points: number;
          nft_points: number;
          participation_points: number;
          prize_points: number;
          public_id: string;
          rank: number;
          social_points: number;
          total: number;
          total_reached_at?: string | null;
          user_id: string;
          version_id: string;
        };
        Update: {
          adjustment_points?: number;
          legacy_points?: number;
          nft_points?: number;
          participation_points?: number;
          prize_points?: number;
          public_id?: string;
          rank?: number;
          social_points?: number;
          total?: number;
          total_reached_at?: string | null;
          user_id?: string;
          version_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "final_standings_version_id_fkey";
            columns: ["version_id"];
            isOneToOne: false;
            referencedRelation: "final_standings_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      final_standings_versions: {
        Row: {
          entry_count: number;
          export_hash: string | null;
          finalized_at: string;
          finalized_by: string | null;
          id: string;
          ledger_watermark: number;
          reason: string | null;
          rules_hash: string;
          season_id: string;
          supersedes_id: string | null;
          version: number;
        };
        Insert: {
          entry_count?: number;
          export_hash?: string | null;
          finalized_at?: string;
          finalized_by?: string | null;
          id?: string;
          ledger_watermark: number;
          reason?: string | null;
          rules_hash: string;
          season_id: string;
          supersedes_id?: string | null;
          version: number;
        };
        Update: {
          entry_count?: number;
          export_hash?: string | null;
          finalized_at?: string;
          finalized_by?: string | null;
          id?: string;
          ledger_watermark?: number;
          reason?: string | null;
          rules_hash?: string;
          season_id?: string;
          supersedes_id?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "final_standings_versions_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "final_standings_versions_supersedes_id_fkey";
            columns: ["supersedes_id"];
            isOneToOne: false;
            referencedRelation: "final_standings_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      guide_messages: {
        Row: {
          created_at: string;
          id: string;
          parts: Json;
          role: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          parts: Json;
          role: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          parts?: Json;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "guide_messages_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      nft_collections: {
        Row: {
          chain_id: number;
          contract: string;
          created_at: string;
          edition: string;
          frozen_at: string | null;
          id: string;
          index_completed_at: string | null;
          index_cursor_block: number | null;
          index_from_block: number;
          index_token_count: number | null;
          name: string;
          notes: string | null;
          snapshot_block: number | null;
          snapshot_block_hash: string | null;
          status: string;
          verification_evidence: string | null;
          verified_at: string | null;
          verified_by: string | null;
        };
        Insert: {
          chain_id: number;
          contract: string;
          created_at?: string;
          edition: string;
          frozen_at?: string | null;
          id?: string;
          index_completed_at?: string | null;
          index_cursor_block?: number | null;
          index_from_block?: number;
          index_token_count?: number | null;
          name: string;
          notes?: string | null;
          snapshot_block?: number | null;
          snapshot_block_hash?: string | null;
          status?: string;
          verification_evidence?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          chain_id?: number;
          contract?: string;
          created_at?: string;
          edition?: string;
          frozen_at?: string | null;
          id?: string;
          index_completed_at?: string | null;
          index_cursor_block?: number | null;
          index_from_block?: number;
          index_token_count?: number | null;
          name?: string;
          notes?: string | null;
          snapshot_block?: number | null;
          snapshot_block_hash?: string | null;
          status?: string;
          verification_evidence?: string | null;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [];
      };
      nft_holdings: {
        Row: {
          burned: boolean;
          level: number | null;
          level_override: number | null;
          owner_address: string;
          synced_at: string;
          token_id: string;
          user_id: string | null;
        };
        Insert: {
          burned?: boolean;
          level?: number | null;
          level_override?: number | null;
          owner_address: string;
          synced_at?: string;
          token_id: string;
          user_id?: string | null;
        };
        Update: {
          burned?: boolean;
          level?: number | null;
          level_override?: number | null;
          owner_address?: string;
          synced_at?: string;
          token_id?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      nft_snapshot_claims: {
        Row: {
          attempts: number;
          collection_id: string;
          evidence: Json;
          id: string;
          last_error: string | null;
          ledger_id: number | null;
          owner_address: string;
          rejected_reason: string | null;
          requested_at: string;
          season_id: string;
          status: string;
          token_id: number;
          user_id: string;
          verified_at: string | null;
        };
        Insert: {
          attempts?: number;
          collection_id: string;
          evidence?: Json;
          id?: string;
          last_error?: string | null;
          ledger_id?: number | null;
          owner_address: string;
          rejected_reason?: string | null;
          requested_at?: string;
          season_id: string;
          status?: string;
          token_id: number;
          user_id: string;
          verified_at?: string | null;
        };
        Update: {
          attempts?: number;
          collection_id?: string;
          evidence?: Json;
          id?: string;
          last_error?: string | null;
          ledger_id?: number | null;
          owner_address?: string;
          rejected_reason?: string | null;
          requested_at?: string;
          season_id?: string;
          status?: string;
          token_id?: number;
          user_id?: string;
          verified_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "nft_snapshot_claims_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "nft_collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "nft_snapshot_claims_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      nft_snapshot_owners: {
        Row: {
          collection_id: string;
          last_transfer_block: number;
          last_transfer_log_index: number;
          owner_address: string;
          token_id: number;
        };
        Insert: {
          collection_id: string;
          last_transfer_block: number;
          last_transfer_log_index: number;
          owner_address: string;
          token_id: number;
        };
        Update: {
          collection_id?: string;
          last_transfer_block?: number;
          last_transfer_log_index?: number;
          owner_address?: string;
          token_id?: number;
        };
        Relationships: [
          {
            foreignKeyName: "nft_snapshot_owners_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "nft_collections";
            referencedColumns: ["id"];
          },
        ];
      };
      operating_costs: {
        Row: {
          amount_usd: number | null;
          basis: string;
          category: string;
          created_at: string;
          description: string;
          evidence: string | null;
          id: string;
          recorded_by: string | null;
          retired_at: string | null;
          verified_at: string | null;
        };
        Insert: {
          amount_usd?: number | null;
          basis: string;
          category: string;
          created_at?: string;
          description: string;
          evidence?: string | null;
          id?: string;
          recorded_by?: string | null;
          retired_at?: string | null;
          verified_at?: string | null;
        };
        Update: {
          amount_usd?: number | null;
          basis?: string;
          category?: string;
          created_at?: string;
          description?: string;
          evidence?: string | null;
          id?: string;
          recorded_by?: string | null;
          retired_at?: string | null;
          verified_at?: string | null;
        };
        Relationships: [];
      };
      operator_nonces: {
        Row: {
          batch_id: string;
          chain_id: number;
          claimed_at: string;
          nonce: number;
          operator_address: string;
        };
        Insert: {
          batch_id: string;
          chain_id: number;
          claimed_at?: string;
          nonce: number;
          operator_address: string;
        };
        Update: {
          batch_id?: string;
          chain_id?: number;
          claimed_at?: string;
          nonce?: number;
          operator_address?: string;
        };
        Relationships: [
          {
            foreignKeyName: "operator_nonces_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "draw_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      ops_alerts: {
        Row: {
          alert_key: string;
          details: Json;
          id: string;
          kind: string;
          last_seen_at: string;
          message: string;
          raised_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
          severity: string;
        };
        Insert: {
          alert_key: string;
          details?: Json;
          id?: string;
          kind: string;
          last_seen_at?: string;
          message: string;
          raised_at?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity?: string;
        };
        Update: {
          alert_key?: string;
          details?: Json;
          id?: string;
          kind?: string;
          last_seen_at?: string;
          message?: string;
          raised_at?: string;
          resolved_at?: string | null;
          resolved_by?: string | null;
          severity?: string;
        };
        Relationships: [];
      };
      points_ledger: {
        Row: {
          amount: number;
          created_at: string;
          created_by: string | null;
          effective_at: string;
          id: number;
          metadata: Json;
          reason: string;
          ref: string | null;
          reversal_reason: string | null;
          reverses_id: number | null;
          reward_subtype: string;
          rule_version_id: string | null;
          season_id: string;
          source_id: string;
          source_type: string;
          user_id: string;
        };
        Insert: {
          amount: number;
          created_at?: string;
          created_by?: string | null;
          effective_at?: string;
          id?: number;
          metadata?: Json;
          reason: string;
          ref?: string | null;
          reversal_reason?: string | null;
          reverses_id?: number | null;
          reward_subtype: string;
          rule_version_id?: string | null;
          season_id: string;
          source_id: string;
          source_type: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          created_at?: string;
          created_by?: string | null;
          effective_at?: string;
          id?: number;
          metadata?: Json;
          reason?: string;
          ref?: string | null;
          reversal_reason?: string | null;
          reverses_id?: number | null;
          reward_subtype?: string;
          rule_version_id?: string | null;
          season_id?: string;
          source_id?: string;
          source_type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "points_ledger_reverses_id_fkey";
            columns: ["reverses_id"];
            isOneToOne: false;
            referencedRelation: "points_ledger";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "points_ledger_rule_version_id_fkey";
            columns: ["rule_version_id"];
            isOneToOne: false;
            referencedRelation: "season_rule_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "points_ledger_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      pool_publications: {
        Row: {
          chain_id: number;
          confirmed_at: string | null;
          contract_address: string;
          error: string | null;
          id: string;
          pool_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          prize_ids: string[];
          remaining: number[];
          status: string;
          tx_hash: string | null;
          weights: number[];
        };
        Insert: {
          chain_id: number;
          confirmed_at?: string | null;
          contract_address: string;
          error?: string | null;
          id?: string;
          pool_version?: number | null;
          prepared_at?: string;
          prepared_by?: string | null;
          prize_ids: string[];
          remaining: number[];
          status?: string;
          tx_hash?: string | null;
          weights: number[];
        };
        Update: {
          chain_id?: number;
          confirmed_at?: string | null;
          contract_address?: string;
          error?: string | null;
          id?: string;
          pool_version?: number | null;
          prepared_at?: string;
          prepared_by?: string | null;
          prize_ids?: string[];
          remaining?: number[];
          status?: string;
          tx_hash?: string | null;
          weights?: number[];
        };
        Relationships: [];
      };
      privy_accounts: {
        Row: {
          created_at: string;
          privy_did: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          privy_did: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          privy_did?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "privy_accounts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      prize_economics: {
        Row: {
          acquisition_usd: number | null;
          cost_evidence: string | null;
          cost_verified_at: string | null;
          fulfillment_usd: number | null;
          funding_evidence: string | null;
          funding_reserved_usd: number;
          funding_verified_at: string | null;
          prize_id: string;
          shipping_usd: number | null;
          stock_evidence: string | null;
          stock_verified_at: string | null;
          stock_verified_qty: number | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          acquisition_usd?: number | null;
          cost_evidence?: string | null;
          cost_verified_at?: string | null;
          fulfillment_usd?: number | null;
          funding_evidence?: string | null;
          funding_reserved_usd?: number;
          funding_verified_at?: string | null;
          prize_id: string;
          shipping_usd?: number | null;
          stock_evidence?: string | null;
          stock_verified_at?: string | null;
          stock_verified_qty?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          acquisition_usd?: number | null;
          cost_evidence?: string | null;
          cost_verified_at?: string | null;
          fulfillment_usd?: number | null;
          funding_evidence?: string | null;
          funding_reserved_usd?: number;
          funding_verified_at?: string | null;
          prize_id?: string;
          shipping_usd?: number | null;
          stock_evidence?: string | null;
          stock_verified_at?: string | null;
          stock_verified_qty?: number | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "prize_economics_prize_id_fkey";
            columns: ["prize_id"];
            isOneToOne: true;
            referencedRelation: "prizes";
            referencedColumns: ["id"];
          },
        ];
      };
      prize_entitlements: {
        Row: {
          created_at: string;
          fulfilled_at: string | null;
          fulfillment_type: string;
          notes: string | null;
          prize_id: string;
          spin_id: string;
          status: string;
          unit_cost_usd: number | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          fulfilled_at?: string | null;
          fulfillment_type: string;
          notes?: string | null;
          prize_id: string;
          spin_id: string;
          status: string;
          unit_cost_usd?: number | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          fulfilled_at?: string | null;
          fulfillment_type?: string;
          notes?: string | null;
          prize_id?: string;
          spin_id?: string;
          status?: string;
          unit_cost_usd?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "prize_entitlements_prize_id_fkey";
            columns: ["prize_id"];
            isOneToOne: false;
            referencedRelation: "prizes";
            referencedColumns: ["id"];
          },
        ];
      };
      prize_restocks: {
        Row: {
          created_at: string;
          created_by: string;
          evidence: string;
          id: string;
          prize_id: string;
          quantity: number;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          evidence: string;
          id?: string;
          prize_id: string;
          quantity: number;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          evidence?: string;
          id?: string;
          prize_id?: string;
          quantity?: number;
        };
        Relationships: [
          {
            foreignKeyName: "prize_restocks_prize_id_fkey";
            columns: ["prize_id"];
            isOneToOne: false;
            referencedRelation: "prizes";
            referencedColumns: ["id"];
          },
        ];
      };
      prizes: {
        Row: {
          active: boolean;
          created_at: string;
          fulfillment_type: string;
          id: string;
          inventory: number | null;
          name: string;
          onchain_index: number | null;
          points: number;
          rarity: string;
          weight: number;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          fulfillment_type?: string;
          id?: string;
          inventory?: number | null;
          name: string;
          onchain_index?: number | null;
          points?: number;
          rarity?: string;
          weight?: number;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          fulfillment_type?: string;
          id?: string;
          inventory?: number | null;
          name?: string;
          onchain_index?: number | null;
          points?: number;
          rarity?: string;
          weight?: number;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          alias_updated_at: string | null;
          avatar_key: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          public_alias: string | null;
          public_id: string;
        };
        Insert: {
          alias_updated_at?: string | null;
          avatar_key?: string | null;
          created_at?: string;
          display_name?: string | null;
          id: string;
          public_alias?: string | null;
          public_id?: string;
        };
        Update: {
          alias_updated_at?: string | null;
          avatar_key?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          public_alias?: string | null;
          public_id?: string;
        };
        Relationships: [];
      };
      reserve_entries: {
        Row: {
          amount_usd: number;
          created_at: string;
          evidence: string;
          id: string;
          recorded_by: string | null;
          verified_at: string;
        };
        Insert: {
          amount_usd: number;
          created_at?: string;
          evidence: string;
          id?: string;
          recorded_by?: string | null;
          verified_at?: string;
        };
        Update: {
          amount_usd?: number;
          created_at?: string;
          evidence?: string;
          id?: string;
          recorded_by?: string | null;
          verified_at?: string;
        };
        Relationships: [];
      };
      season_collections: {
        Row: {
          collection_id: string;
          season_id: string;
        };
        Insert: {
          collection_id: string;
          season_id: string;
        };
        Update: {
          collection_id?: string;
          season_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "season_collections_collection_id_fkey";
            columns: ["collection_id"];
            isOneToOne: false;
            referencedRelation: "nft_collections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "season_collections_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      season_rule_versions: {
        Row: {
          frozen_at: string;
          frozen_by: string | null;
          id: string;
          rules: Json;
          rules_hash: string;
          season_id: string;
          version: number;
        };
        Insert: {
          frozen_at?: string;
          frozen_by?: string | null;
          id?: string;
          rules: Json;
          rules_hash: string;
          season_id: string;
          version: number;
        };
        Update: {
          frozen_at?: string;
          frozen_by?: string | null;
          id?: string;
          rules?: Json;
          rules_hash?: string;
          season_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "season_rule_versions_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      season_scores: {
        Row: {
          adjustment_points: number;
          last_ledger_id: number;
          legacy_points: number;
          nft_points: number;
          participation_points: number;
          prize_points: number;
          season_id: string;
          social_points: number;
          total: number;
          total_reached_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          adjustment_points?: number;
          last_ledger_id?: number;
          legacy_points?: number;
          nft_points?: number;
          participation_points?: number;
          prize_points?: number;
          season_id: string;
          social_points?: number;
          total?: number;
          total_reached_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          adjustment_points?: number;
          last_ledger_id?: number;
          legacy_points?: number;
          nft_points?: number;
          participation_points?: number;
          prize_points?: number;
          season_id?: string;
          social_points?: number;
          total?: number;
          total_reached_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "season_scores_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      seasons: {
        Row: {
          activated_at: string | null;
          activated_by: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string | null;
          finalized_at: string | null;
          finalized_by: string | null;
          id: string;
          is_legacy: boolean;
          name: string;
          notes: string | null;
          rule_version_id: string | null;
          rules: Json;
          rules_hash: string | null;
          settlement_deadline: string | null;
          settling_at: string | null;
          slug: string;
          starts_at: string | null;
          status: string;
        };
        Insert: {
          activated_at?: string | null;
          activated_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at?: string | null;
          finalized_at?: string | null;
          finalized_by?: string | null;
          id?: string;
          is_legacy?: boolean;
          name: string;
          notes?: string | null;
          rule_version_id?: string | null;
          rules?: Json;
          rules_hash?: string | null;
          settlement_deadline?: string | null;
          settling_at?: string | null;
          slug: string;
          starts_at?: string | null;
          status?: string;
        };
        Update: {
          activated_at?: string | null;
          activated_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          ends_at?: string | null;
          finalized_at?: string | null;
          finalized_by?: string | null;
          id?: string;
          is_legacy?: boolean;
          name?: string;
          notes?: string | null;
          rule_version_id?: string | null;
          rules?: Json;
          rules_hash?: string | null;
          settlement_deadline?: string | null;
          settling_at?: string | null;
          slug?: string;
          starts_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "seasons_rule_version_fk";
            columns: ["rule_version_id"];
            isOneToOne: false;
            referencedRelation: "season_rule_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      social_award_slots: {
        Row: {
          award_day: string;
          created_at: string;
          season_id: string;
          share_id: string;
          user_id: string;
        };
        Insert: {
          award_day: string;
          created_at?: string;
          season_id: string;
          share_id: string;
          user_id: string;
        };
        Update: {
          award_day?: string;
          created_at?: string;
          season_id?: string;
          share_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "social_award_slots_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "social_award_slots_share_id_fkey";
            columns: ["share_id"];
            isOneToOne: true;
            referencedRelation: "social_shares";
            referencedColumns: ["id"];
          },
        ];
      };
      social_shares: {
        Row: {
          author_username: string | null;
          author_x_user_id: string | null;
          award_day: string;
          evidence: Json;
          id: string;
          ledger_id: number | null;
          post_created_at: string | null;
          post_id: string;
          rejection_reason: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          season_id: string;
          spin_id: string;
          status: string;
          submitted_at: string;
          user_id: string;
          verifier: string | null;
          x_account_id: string;
        };
        Insert: {
          author_username?: string | null;
          author_x_user_id?: string | null;
          award_day: string;
          evidence?: Json;
          id?: string;
          ledger_id?: number | null;
          post_created_at?: string | null;
          post_id: string;
          rejection_reason?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          season_id: string;
          spin_id: string;
          status?: string;
          submitted_at?: string;
          user_id: string;
          verifier?: string | null;
          x_account_id: string;
        };
        Update: {
          author_username?: string | null;
          author_x_user_id?: string | null;
          award_day?: string;
          evidence?: Json;
          id?: string;
          ledger_id?: number | null;
          post_created_at?: string | null;
          post_id?: string;
          rejection_reason?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          season_id?: string;
          spin_id?: string;
          status?: string;
          submitted_at?: string;
          user_id?: string;
          verifier?: string | null;
          x_account_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "social_shares_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "social_shares_spin_id_fkey";
            columns: ["spin_id"];
            isOneToOne: false;
            referencedRelation: "spins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "social_shares_x_account_id_fkey";
            columns: ["x_account_id"];
            isOneToOne: false;
            referencedRelation: "x_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      spin_credits: {
        Row: {
          created_at: string;
          created_by: string | null;
          grant_id: string | null;
          id: string;
          kind: string;
          ref: string | null;
          source: string;
          used_at: string | null;
          used_spin_id: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          grant_id?: string | null;
          id?: string;
          kind?: string;
          ref?: string | null;
          source: string;
          used_at?: string | null;
          used_spin_id?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          grant_id?: string | null;
          id?: string;
          kind?: string;
          ref?: string | null;
          source?: string;
          used_at?: string | null;
          used_spin_id?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      spin_grants: {
        Row: {
          count: number;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          note: string;
          user_id: string;
        };
        Insert: {
          count: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind: string;
          note?: string;
          user_id: string;
        };
        Update: {
          count?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          note?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      spin_purchases: {
        Row: {
          chain_id: number;
          created_at: string;
          id: string;
          paid_at: string | null;
          payer: string | null;
          price_usd: number | null;
          price_wei: number;
          quantity: number;
          status: string;
          treasury: string;
          tx_hash: string | null;
          user_id: string;
        };
        Insert: {
          chain_id: number;
          created_at?: string;
          id?: string;
          paid_at?: string | null;
          payer?: string | null;
          price_usd?: number | null;
          price_wei: number;
          quantity: number;
          status?: string;
          treasury: string;
          tx_hash?: string | null;
          user_id: string;
        };
        Update: {
          chain_id?: number;
          created_at?: string;
          id?: string;
          paid_at?: string | null;
          payer?: string | null;
          price_usd?: number | null;
          price_wei?: number;
          quantity?: number;
          status?: string;
          treasury?: string;
          tx_hash?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      spins: {
        Row: {
          batch_id: string | null;
          bonus_points: number | null;
          chain_id: number | null;
          contract_address: string | null;
          created_at: string;
          credit_id: string;
          fulfilled_at: string | null;
          id: string;
          participation_points: number | null;
          points: number | null;
          prize_id: string | null;
          prize_name: string | null;
          prize_onchain_index: number | null;
          random_word: string | null;
          rarity: string | null;
          request_tx: string | null;
          roll: number | null;
          rule_version_id: string | null;
          score_note: string | null;
          scored: boolean | null;
          season_id: string | null;
          settled_evidence: Json | null;
          status: string;
          total_weight: number | null;
          user_id: string;
          vrf_request_id: string | null;
        };
        Insert: {
          batch_id?: string | null;
          bonus_points?: number | null;
          chain_id?: number | null;
          contract_address?: string | null;
          created_at?: string;
          credit_id: string;
          fulfilled_at?: string | null;
          id?: string;
          participation_points?: number | null;
          points?: number | null;
          prize_id?: string | null;
          prize_name?: string | null;
          prize_onchain_index?: number | null;
          random_word?: string | null;
          rarity?: string | null;
          request_tx?: string | null;
          roll?: number | null;
          rule_version_id?: string | null;
          score_note?: string | null;
          scored?: boolean | null;
          season_id?: string | null;
          settled_evidence?: Json | null;
          status?: string;
          total_weight?: number | null;
          user_id: string;
          vrf_request_id?: string | null;
        };
        Update: {
          batch_id?: string | null;
          bonus_points?: number | null;
          chain_id?: number | null;
          contract_address?: string | null;
          created_at?: string;
          credit_id?: string;
          fulfilled_at?: string | null;
          id?: string;
          participation_points?: number | null;
          points?: number | null;
          prize_id?: string | null;
          prize_name?: string | null;
          prize_onchain_index?: number | null;
          random_word?: string | null;
          rarity?: string | null;
          request_tx?: string | null;
          roll?: number | null;
          rule_version_id?: string | null;
          score_note?: string | null;
          scored?: boolean | null;
          season_id?: string | null;
          settled_evidence?: Json | null;
          status?: string;
          total_weight?: number | null;
          user_id?: string;
          vrf_request_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "spins_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "draw_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "spins_prize_id_fkey";
            columns: ["prize_id"];
            isOneToOne: false;
            referencedRelation: "prizes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "spins_rule_version_id_fkey";
            columns: ["rule_version_id"];
            isOneToOne: false;
            referencedRelation: "season_rule_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "spins_season_id_fkey";
            columns: ["season_id"];
            isOneToOne: false;
            referencedRelation: "seasons";
            referencedColumns: ["id"];
          },
        ];
      };
      sponsored_budgets: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          evidence: string;
          funded_usd: number;
          id: string;
          name: string;
          pause_threshold_usd: number;
          source: string;
          verified_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          evidence: string;
          funded_usd: number;
          id?: string;
          name: string;
          pause_threshold_usd?: number;
          source: string;
          verified_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          evidence?: string;
          funded_usd?: number;
          id?: string;
          name?: string;
          pause_threshold_usd?: number;
          source?: string;
          verified_at?: string;
        };
        Relationships: [];
      };
      sponsored_reservations: {
        Row: {
          actual_usd: number | null;
          budget_id: string;
          created_at: string;
          credit_id: string;
          reserved_usd: number;
          settled_at: string | null;
          status: string;
        };
        Insert: {
          actual_usd?: number | null;
          budget_id: string;
          created_at?: string;
          credit_id: string;
          reserved_usd: number;
          settled_at?: string | null;
          status?: string;
        };
        Update: {
          actual_usd?: number | null;
          budget_id?: string;
          created_at?: string;
          credit_id?: string;
          reserved_usd?: number;
          settled_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sponsored_reservations_budget_id_fkey";
            columns: ["budget_id"];
            isOneToOne: false;
            referencedRelation: "sponsored_budgets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sponsored_reservations_credit_id_fkey";
            columns: ["credit_id"];
            isOneToOne: true;
            referencedRelation: "spin_credits";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          granted_at: string | null;
          granted_by: string | null;
          id: string;
          note: string | null;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          granted_at?: string | null;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          granted_at?: string | null;
          granted_by?: string | null;
          id?: string;
          note?: string | null;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      wallet_challenges: {
        Row: {
          address: string;
          chain_id: number;
          consumed_at: string | null;
          domain: string;
          expires_at: string;
          issued_at: string;
          message: string;
          nonce: string;
          uri: string;
          user_id: string;
        };
        Insert: {
          address: string;
          chain_id: number;
          consumed_at?: string | null;
          domain: string;
          expires_at: string;
          issued_at?: string;
          message: string;
          nonce: string;
          uri: string;
          user_id: string;
        };
        Update: {
          address?: string;
          chain_id?: number;
          consumed_at?: string | null;
          domain?: string;
          expires_at?: string;
          issued_at?: string;
          message?: string;
          nonce?: string;
          uri?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      wallet_nonces: {
        Row: {
          created_at: string;
          nonce: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          nonce: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          nonce?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      wallets: {
        Row: {
          address: string;
          chain_id: number | null;
          id: string;
          is_default: boolean;
          kind: string;
          user_id: string;
          verification: string;
          verified_at: string;
        };
        Insert: {
          address: string;
          chain_id?: number | null;
          id?: string;
          is_default?: boolean;
          kind?: string;
          user_id: string;
          verification?: string;
          verified_at?: string;
        };
        Update: {
          address?: string;
          chain_id?: number | null;
          id?: string;
          is_default?: boolean;
          kind?: string;
          user_id?: string;
          verification?: string;
          verified_at?: string;
        };
        Relationships: [];
      };
      x_accounts: {
        Row: {
          evidence: Json;
          id: string;
          linked_at: string;
          unlinked_at: string | null;
          user_id: string;
          verification: string;
          x_user_id: string | null;
          x_username: string;
        };
        Insert: {
          evidence?: Json;
          id?: string;
          linked_at?: string;
          unlinked_at?: string | null;
          user_id: string;
          verification: string;
          x_user_id?: string | null;
          x_username: string;
        };
        Update: {
          evidence?: Json;
          id?: string;
          linked_at?: string;
          unlinked_at?: string | null;
          user_id?: string;
          verification?: string;
          x_user_id?: string | null;
          x_username?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      activate_season: {
        Args: { _season_id: string; _actor: string };
        Returns: {
          activated_at: string | null;
          activated_by: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string | null;
          finalized_at: string | null;
          finalized_by: string | null;
          id: string;
          is_legacy: boolean;
          name: string;
          notes: string | null;
          rule_version_id: string | null;
          rules: Json;
          rules_hash: string | null;
          settlement_deadline: string | null;
          settling_at: string | null;
          slug: string;
          starts_at: string | null;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "seasons";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      adjust_points: {
        Args: {
          _season_id: string;
          _user_id: string;
          _amount: number;
          _reason: string;
          _actor: string;
        };
        Returns: number;
      };
      admin_upsert_prize: {
        Args: {
          _id: string;
          _name: string;
          _rarity: string;
          _weight: number;
          _inventory: number;
          _active: boolean;
          _fulfillment_type: string;
          _actor: string;
        };
        Returns: {
          active: boolean;
          created_at: string;
          fulfillment_type: string;
          id: string;
          inventory: number | null;
          name: string;
          onchain_index: number | null;
          points: number;
          rarity: string;
          weight: number;
        };
        SetofOptions: {
          from: "*";
          to: "prizes";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      advance_season_states: {
        Args: never;
        Returns: number;
      };
      apply_season_backfill: {
        Args: { _season_id: string; _actor: string };
        Returns: number;
      };
      apply_snapshot_transfers: {
        Args: {
          _collection_id: string;
          _from_block: number;
          _to_block: number;
          _rows: Json;
          _complete: boolean;
        };
        Returns: {
          chain_id: number;
          contract: string;
          created_at: string;
          edition: string;
          frozen_at: string | null;
          id: string;
          index_completed_at: string | null;
          index_cursor_block: number | null;
          index_from_block: number;
          index_token_count: number | null;
          name: string;
          notes: string | null;
          snapshot_block: number | null;
          snapshot_block_hash: string | null;
          status: string;
          verification_evidence: string | null;
          verified_at: string | null;
          verified_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "nft_collections";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      available_prize_pool: {
        Args: never;
        Returns: {
          prize_id: string;
          name: string;
          rarity: string;
          weight: number;
          inventory: number;
          fulfillment_type: string;
          onchain_index: number;
          probability: number;
        }[];
      };
      begin_draw_batch: {
        Args: {
          _user_id: string;
          _idempotency_key: string;
          _count: number;
          _chain_id: number;
          _contract: string;
          _pool_version: number;
        };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      claim_batch_submission: {
        Args: { _batch_id: string };
        Returns: boolean;
      };
      complete_spin_purchase: {
        Args: { _purchase_id: string; _tx_hash: string; _payer: string };
        Returns: {
          chain_id: number;
          created_at: string;
          id: string;
          paid_at: string | null;
          payer: string | null;
          price_usd: number | null;
          price_wei: number;
          quantity: number;
          status: string;
          treasury: string;
          tx_hash: string | null;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "spin_purchases";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      confirm_pool_publication: {
        Args: {
          _publication_id: string;
          _pool_version: number;
          _chain_weights: number[];
          _chain_remaining: number[];
          _actor: string;
        };
        Returns: {
          chain_id: number;
          confirmed_at: string | null;
          contract_address: string;
          error: string | null;
          id: string;
          pool_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          prize_ids: string[];
          remaining: number[];
          status: string;
          tx_hash: string | null;
          weights: number[];
        };
        SetofOptions: {
          from: "*";
          to: "pool_publications";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      create_season_draft: {
        Args: {
          _slug: string;
          _name: string;
          _starts_at: string;
          _ends_at: string;
          _settlement_deadline: string;
          _rules: Json;
          _notes: string;
          _actor: string;
        };
        Returns: {
          activated_at: string | null;
          activated_by: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string | null;
          finalized_at: string | null;
          finalized_by: string | null;
          id: string;
          is_legacy: boolean;
          name: string;
          notes: string | null;
          rule_version_id: string | null;
          rules: Json;
          rules_hash: string | null;
          settlement_deadline: string | null;
          settling_at: string | null;
          slug: string;
          starts_at: string | null;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "seasons";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      default_season_rules: {
        Args: never;
        Returns: Json;
      };
      economic_status: {
        Args: never;
        Returns: Json;
      };
      expected_spin_cost_usd: {
        Args: never;
        Returns: number;
      };
      fail_pool_publication: {
        Args: { _publication_id: string; _error: string; _actor: string };
        Returns: {
          chain_id: number;
          confirmed_at: string | null;
          contract_address: string;
          error: string | null;
          id: string;
          pool_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          prize_ids: string[];
          remaining: number[];
          status: string;
          tx_hash: string | null;
          weights: number[];
        };
        SetofOptions: {
          from: "*";
          to: "pool_publications";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      finalize_season: {
        Args: { _season_id: string; _actor: string };
        Returns: {
          entry_count: number;
          export_hash: string | null;
          finalized_at: string;
          finalized_by: string | null;
          id: string;
          ledger_watermark: number;
          reason: string | null;
          rules_hash: string;
          season_id: string;
          supersedes_id: string | null;
          version: number;
        };
        SetofOptions: {
          from: "*";
          to: "final_standings_versions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      flag_batch_conflict: {
        Args: { _batch_id: string; _reason: string };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_my_season_standing: {
        Args: { _season_id: string };
        Returns: {
          rank: number;
          public_id: string;
          alias: string;
          avatar_key: string;
          total_points: string;
          nft_points: string;
          participation_points: string;
          prize_points: string;
          social_points: string;
          adjustment_points: string;
          legacy_points: string;
          total_reached_at: string;
          total_count: number;
        }[];
      };
      get_season_leaderboard: {
        Args: { _season_id: string; _limit?: number; _offset?: number };
        Returns: {
          rank: number;
          public_id: string;
          alias: string;
          avatar_key: string;
          total_points: string;
          nft_points: string;
          participation_points: string;
          prize_points: string;
          social_points: string;
          adjustment_points: string;
          legacy_points: string;
          total_count: number;
          standings_version: number;
          is_final: boolean;
        }[];
      };
      get_season_rules: {
        Args: { _season_id: string };
        Returns: Json;
      };
      grant_spins: {
        Args: {
          _user_id: string;
          _count: number;
          _reason: string;
          _actor: string;
          _source?: string;
          _kind?: string;
        };
        Returns: number;
      };
      use_demo_spins: {
        Args: { _user_id: string; _count: number };
        Returns: number;
      };
      has_role: {
        Args: { _user_id: string; _role: Database["public"]["Enums"]["app_role"] };
        Returns: boolean;
      };
      issue_wallet_challenge: {
        Args: {
          _user_id: string;
          _address: string;
          _chain_id: number;
          _domain: string;
          _uri: string;
          _nonce: string;
          _message: string;
          _ttl_seconds?: number;
        };
        Returns: {
          address: string;
          chain_id: number;
          consumed_at: string | null;
          domain: string;
          expires_at: string;
          issued_at: string;
          message: string;
          nonce: string;
          uri: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "wallet_challenges";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      ledger_drift: {
        Args: { _season_id: string };
        Returns: {
          user_id: string;
          aggregate_total: number;
          ledger_total: number;
        }[];
      };
      link_privy_account: {
        Args: { _user_id: string; _privy_did: string };
        Returns: unknown;
      };
      link_privy_wallet: {
        Args: { _user_id: string; _address: string; _kind: string };
        Returns: {
          address: string;
          chain_id: number | null;
          id: string;
          is_default: boolean;
          kind: string;
          user_id: string;
          verification: string;
          verified_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "wallets";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      link_wallet_with_challenge: {
        Args: {
          _user_id: string;
          _nonce: string;
          _address: string;
          _domain: string;
          _chain_id: number;
        };
        Returns: {
          address: string;
          chain_id: number | null;
          id: string;
          is_default: boolean;
          kind: string;
          user_id: string;
          verification: string;
          verified_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "wallets";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      link_x_account: {
        Args: {
          _user_id: string;
          _username: string;
          _x_user_id: string;
          _verification: string;
          _evidence: Json;
        };
        Returns: {
          evidence: Json;
          id: string;
          linked_at: string;
          unlinked_at: string | null;
          user_id: string;
          verification: string;
          x_user_id: string | null;
          x_username: string;
        };
        SetofOptions: {
          from: "*";
          to: "x_accounts";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      list_seasons: {
        Args: never;
        Returns: {
          id: string;
          slug: string;
          name: string;
          status: string;
          is_legacy: boolean;
          starts_at: string;
          ends_at: string;
          settlement_deadline: string;
          rules: Json;
          rules_hash: string;
          finalized_at: string;
          standings_version: number;
          standings_export_hash: string;
        }[];
      };
      machine_readiness: {
        Args: { _user_id: string };
        Returns: Json;
      };
      marginal_spin_cost_usd: {
        Args: never;
        Returns: number;
      };
      mark_pool_publication_sent: {
        Args: { _publication_id: string; _tx_hash: string };
        Returns: {
          chain_id: number;
          confirmed_at: string | null;
          contract_address: string;
          error: string | null;
          id: string;
          pool_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          prize_ids: string[];
          remaining: number[];
          status: string;
          tx_hash: string | null;
          weights: number[];
        };
        SetofOptions: {
          from: "*";
          to: "pool_publications";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      mark_submission_broadcast: {
        Args: { _tx_hash: string; _error: string };
        Returns: {
          batch_id: string;
          block_hash: string | null;
          block_number: number | null;
          broadcast_attempts: number;
          chain_id: number;
          created_at: string;
          id: string;
          last_broadcast_at: string | null;
          last_error: string | null;
          nonce: number;
          operator_address: string;
          raw_tx: string;
          status: string;
          tx_hash: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      normalize_season_rules: {
        Args: { _rules: Json };
        Returns: Json;
      };
      normalize_x_post_url: {
        Args: { _url: string };
        Returns: string;
      };
      open_draw_work: {
        Args: { _limit?: number };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      ops_monitor_scan: {
        Args: never;
        Returns: {
          alert_key: string;
          details: Json;
          id: string;
          kind: string;
          last_seen_at: string;
          message: string;
          raised_at: string;
          resolved_at: string | null;
          resolved_by: string | null;
          severity: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "ops_alerts";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      outstanding_spin_count: {
        Args: never;
        Returns: number;
      };
      prepare_pool_publication: {
        Args: {
          _chain_id: number;
          _contract: string;
          _chain_pool_version: number;
          _chain_remaining: number[];
          _chain_pending: number;
          _actor: string;
        };
        Returns: {
          chain_id: number;
          confirmed_at: string | null;
          contract_address: string;
          error: string | null;
          id: string;
          pool_version: number | null;
          prepared_at: string;
          prepared_by: string | null;
          prize_ids: string[];
          remaining: number[];
          status: string;
          tx_hash: string | null;
          weights: number[];
        };
        SetofOptions: {
          from: "*";
          to: "pool_publications";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      prize_bonus_for: {
        Args: { _rules: Json; _prize_id: string; _rarity: string };
        Returns: number;
      };
      prize_catalog_problems: {
        Args: never;
        Returns: {
          prize_id: string;
          problem: string;
        }[];
      };
      prize_unit_cost_usd: {
        Args: { _prize_id: string };
        Returns: number;
      };
      purchase_gate: {
        Args: { _quantity: number };
        Returns: {
          ok: boolean;
          reason: string;
          required_usd: number;
          reserves_usd: number;
        }[];
      };
      raise_ops_alert: {
        Args: { _key: string; _kind: string; _severity: string; _message: string; _details: Json };
        Returns: string;
      };
      record_burn_claim: {
        Args: {
          _user_id: string;
          _chain_id: number;
          _contract: string;
          _token_id: string;
          _tx_hash: string;
          _log_index: number;
          _from: string;
          _to: string;
          _level: number;
          _level_source: string;
          _block_number: number;
          _block_hash: string;
          _confirmations: number;
          _evidence: Json;
        };
        Returns: {
          block_hash: string | null;
          block_number: number | null;
          chain_id: number;
          confirmations: number | null;
          contract: string;
          created_at: string;
          credit_id: string | null;
          evidence: Json;
          from_address: string | null;
          id: string;
          level: number;
          level_source: string | null;
          log_index: number | null;
          to_address: string | null;
          token_id: string;
          tx_hash: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "burn_claims";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_request_receipt: {
        Args: {
          _tx_hash: string;
          _success: boolean;
          _block_number: number;
          _block_hash: string;
          _block_time: string;
          _confirmations: number;
          _min_confirmations: number;
          _request_id: string;
          _spin_ids: string[];
        };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      record_signed_submission: {
        Args: {
          _batch_id: string;
          _chain_id: number;
          _operator: string;
          _nonce: number;
          _tx_hash: string;
          _raw_tx: string;
        };
        Returns: {
          batch_id: string;
          block_hash: string | null;
          block_number: number | null;
          broadcast_attempts: number;
          chain_id: number;
          created_at: string;
          id: string;
          last_broadcast_at: string | null;
          last_error: string | null;
          nonce: number;
          operator_address: string;
          raw_tx: string;
          status: string;
          tx_hash: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_submissions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      refund_batch_prebroadcast: {
        Args: { _batch_id: string; _reason: string };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      request_snapshot_claims: {
        Args: { _user_id: string; _season_id: string };
        Returns: {
          attempts: number;
          collection_id: string;
          evidence: Json;
          id: string;
          last_error: string | null;
          ledger_id: number | null;
          owner_address: string;
          rejected_reason: string | null;
          requested_at: string;
          season_id: string;
          status: string;
          token_id: number;
          user_id: string;
          verified_at: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "nft_snapshot_claims";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      reserve_balance_usd: {
        Args: never;
        Returns: number;
      };
      reset_snapshot_index: {
        Args: { _collection_id: string; _actor: string };
        Returns: unknown;
      };
      resolve_batch_conflict: {
        Args: { _batch_id: string; _resolution: string; _evidence: Json; _actor: string };
        Returns: {
          chain_id: number;
          contract_address: string;
          created_at: string;
          id: string;
          idempotency_key: string;
          last_error: string | null;
          pool_version: number;
          prize_map: Json;
          reconciled_at: string | null;
          refund_reason: string | null;
          request_block: number | null;
          request_block_hash: string | null;
          request_block_time: string | null;
          request_confirmations: number | null;
          request_id: string | null;
          request_tx: string | null;
          rule_version_id: string | null;
          season_id: string | null;
          spin_count: number;
          spin_ids: string[];
          status: string;
          submission_claimed_at: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "draw_batches";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      resolve_ops_alert: {
        Args: { _alert_id: string; _actor: string };
        Returns: unknown;
      };
      resolve_snapshot_claim: {
        Args: {
          _claim_id: string;
          _outcome: string;
          _snapshot_owner: string;
          _evidence: Json;
          _error: string;
        };
        Returns: {
          attempts: number;
          collection_id: string;
          evidence: Json;
          id: string;
          last_error: string | null;
          ledger_id: number | null;
          owner_address: string;
          rejected_reason: string | null;
          requested_at: string;
          season_id: string;
          status: string;
          token_id: number;
          user_id: string;
          verified_at: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "nft_snapshot_claims";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      restock_prize: {
        Args: { _prize_id: string; _quantity: number; _evidence: string; _actor: string };
        Returns: {
          active: boolean;
          created_at: string;
          fulfillment_type: string;
          id: string;
          inventory: number | null;
          name: string;
          onchain_index: number | null;
          points: number;
          rarity: string;
          weight: number;
        };
        SetofOptions: {
          from: "*";
          to: "prizes";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      reverse_points: {
        Args: { _ledger_id: number; _amount: number; _reason: string; _actor: string };
        Returns: number;
      };
      review_social_share: {
        Args: {
          _share_id: string;
          _decision: string;
          _verifier: string;
          _evidence: Json;
          _reason: string;
          _actor: string;
        };
        Returns: {
          author_username: string | null;
          author_x_user_id: string | null;
          award_day: string;
          evidence: Json;
          id: string;
          ledger_id: number | null;
          post_created_at: string | null;
          post_id: string;
          rejection_reason: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          season_id: string;
          spin_id: string;
          status: string;
          submitted_at: string;
          user_id: string;
          verifier: string | null;
          x_account_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "social_shares";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      rules_hash: {
        Args: { _rules: Json };
        Returns: string;
      };
      season_backfill_report: {
        Args: { _season_id: string };
        Returns: Json;
      };
      season_unresolved_items: {
        Args: { _season_id: string };
        Returns: {
          kind: string;
          item_count: number;
        }[];
      };
      set_default_wallet: {
        Args: { _user_id: string; _address: string };
        Returns: {
          address: string;
          chain_id: number | null;
          id: string;
          is_default: boolean;
          kind: string;
          user_id: string;
          verification: string;
          verified_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "wallets";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_holding_level_override: {
        Args: { _token_id: string; _level: number; _actor: string };
        Returns: unknown;
      };
      set_public_profile: {
        Args: { _user_id: string; _alias: string; _avatar_key: string };
        Returns: {
          public_id: string;
          public_alias: string;
          avatar_key: string;
        }[];
      };
      set_season_collections: {
        Args: { _season_id: string; _collection_ids: string[]; _actor: string };
        Returns: number;
      };
      settle_spin: {
        Args: {
          _spin_id: string;
          _chain_status: number;
          _prize_index: number;
          _random_word: string;
          _request_id: string;
          _evidence: Json;
        };
        Returns: {
          batch_id: string | null;
          bonus_points: number | null;
          chain_id: number | null;
          contract_address: string | null;
          created_at: string;
          credit_id: string;
          fulfilled_at: string | null;
          id: string;
          participation_points: number | null;
          points: number | null;
          prize_id: string | null;
          prize_name: string | null;
          prize_onchain_index: number | null;
          random_word: string | null;
          rarity: string | null;
          request_tx: string | null;
          roll: number | null;
          rule_version_id: string | null;
          score_note: string | null;
          scored: boolean | null;
          season_id: string | null;
          settled_evidence: Json | null;
          status: string;
          total_weight: number | null;
          user_id: string;
          vrf_request_id: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "spins";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      spin_share_code: {
        Args: { _spin_id: string };
        Returns: string;
      };
      standings_export_text: {
        Args: { _version_id: string };
        Returns: string;
      };
      submit_social_share: {
        Args: { _user_id: string; _spin_id: string; _post_url: string };
        Returns: {
          author_username: string | null;
          author_x_user_id: string | null;
          award_day: string;
          evidence: Json;
          id: string;
          ledger_id: number | null;
          post_created_at: string | null;
          post_id: string;
          rejection_reason: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          season_id: string;
          spin_id: string;
          status: string;
          submitted_at: string;
          user_id: string;
          verifier: string | null;
          x_account_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "social_shares";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      supersede_final_standings: {
        Args: { _season_id: string; _reason: string; _actor: string };
        Returns: {
          entry_count: number;
          export_hash: string | null;
          finalized_at: string;
          finalized_by: string | null;
          id: string;
          ledger_watermark: number;
          reason: string | null;
          rules_hash: string;
          season_id: string;
          supersedes_id: string | null;
          version: number;
        };
        SetofOptions: {
          from: "*";
          to: "final_standings_versions";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      sync_live_holdings: {
        Args: { _user_id: string; _rows: Json };
        Returns: number;
      };
      update_season_draft: {
        Args: {
          _season_id: string;
          _name: string;
          _starts_at: string;
          _ends_at: string;
          _settlement_deadline: string;
          _rules: Json;
          _notes: string;
          _actor: string;
        };
        Returns: {
          activated_at: string | null;
          activated_by: string | null;
          created_at: string;
          created_by: string | null;
          ends_at: string | null;
          finalized_at: string | null;
          finalized_by: string | null;
          id: string;
          is_legacy: boolean;
          name: string;
          notes: string | null;
          rule_version_id: string | null;
          rules: Json;
          rules_hash: string | null;
          settlement_deadline: string | null;
          settling_at: string | null;
          slug: string;
          starts_at: string | null;
          status: string;
        };
        SetofOptions: {
          from: "*";
          to: "seasons";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      user_id_by_email: {
        Args: { _email: string };
        Returns: string;
      };
      verify_nft_collection: {
        Args: { _collection_id: string; _evidence: string; _actor: string };
        Returns: {
          chain_id: number;
          contract: string;
          created_at: string;
          edition: string;
          frozen_at: string | null;
          id: string;
          index_completed_at: string | null;
          index_cursor_block: number | null;
          index_from_block: number;
          index_token_count: number | null;
          name: string;
          notes: string | null;
          snapshot_block: number | null;
          snapshot_block_hash: string | null;
          status: string;
          verification_evidence: string | null;
          verified_at: string | null;
          verified_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "nft_collections";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      worst_case_obligation_usd: {
        Args: { _spins: number };
        Returns: number;
      };
      worst_case_spin_cost_usd: {
        Args: never;
        Returns: number;
      };
    };
    Enums: {
      app_role: "admin" | "moderator" | "user";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const;
