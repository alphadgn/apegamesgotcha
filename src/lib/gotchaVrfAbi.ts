// Generated from contracts/out/GotchaVRF.sol/GotchaVRF.json (`forge inspect GotchaVRF abi --json`).
// Regenerate after any contract change. There is intentionally no cancel/re-request function.
export const gotchaVrfAbi = [
  {
    type: "constructor",
    inputs: [
      {
        name: "coordinator",
        type: "address",
        internalType: "address",
      },
      {
        name: "subId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "keyHash_",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "confirmations",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "gasBase",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "gasPerSpin",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "nativePayment_",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "operator_",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "MAX_BATCH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_PRIZES",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "NO_PRIZE",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "UNLIMITED",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "acceptOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "callbackGasBase",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "callbackGasPerSpin",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint32",
        internalType: "uint32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPool",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct GotchaVRF.Prize[]",
        components: [
          {
            name: "weight",
            type: "uint32",
            internalType: "uint32",
          },
          {
            name: "remaining",
            type: "uint32",
            internalType: "uint32",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRequestSpins",
    inputs: [
      {
        name: "requestId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getSpin",
    inputs: [
      {
        name: "spinId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct GotchaVRF.Spin",
        components: [
          {
            name: "status",
            type: "uint8",
            internalType: "enum GotchaVRF.Status",
          },
          {
            name: "prizeIndex",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "requestedAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "requestId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "randomWord",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getSpins",
    inputs: [
      {
        name: "spinIds",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        internalType: "struct GotchaVRF.Spin[]",
        components: [
          {
            name: "status",
            type: "uint8",
            internalType: "enum GotchaVRF.Status",
          },
          {
            name: "prizeIndex",
            type: "uint8",
            internalType: "uint8",
          },
          {
            name: "requestedAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "requestId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "randomWord",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "keyHash",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nativePayment",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "operator",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingRequests",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "poolVersion",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "rawFulfillRandomWords",
    inputs: [
      {
        name: "requestId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "randomWords",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requestConfirmations",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "requestSpins",
    inputs: [
      {
        name: "spinIds",
        type: "bytes32[]",
        internalType: "bytes32[]",
      },
    ],
    outputs: [
      {
        name: "requestId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requestsPaused",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "s_vrfCoordinator",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IVRFCoordinatorV2Plus",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setCoordinator",
    inputs: [
      {
        name: "_vrfCoordinator",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setOperator",
    inputs: [
      {
        name: "operator_",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPool",
    inputs: [
      {
        name: "weights",
        type: "uint32[]",
        internalType: "uint32[]",
      },
      {
        name: "remaining",
        type: "uint32[]",
        internalType: "uint32[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setRequestsPaused",
    inputs: [
      {
        name: "paused",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setVrfConfig",
    inputs: [
      {
        name: "subId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "keyHash_",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "confirmations",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "gasBase",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "gasPerSpin",
        type: "uint32",
        internalType: "uint32",
      },
      {
        name: "nativePayment_",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "subscriptionId",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "CoordinatorSet",
    inputs: [
      {
        name: "vrfCoordinator",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OperatorUpdated",
    inputs: [
      {
        name: "operator",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferRequested",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PoolUpdated",
    inputs: [
      {
        name: "version",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "weights",
        type: "uint32[]",
        indexed: false,
        internalType: "uint32[]",
      },
      {
        name: "remaining",
        type: "uint32[]",
        indexed: false,
        internalType: "uint32[]",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RequestsPausedSet",
    inputs: [
      {
        name: "paused",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SpinFulfilled",
    inputs: [
      {
        name: "spinId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "requestId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "randomWord",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "prizeIndex",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SpinRequested",
    inputs: [
      {
        name: "spinId",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "requestId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "VrfConfigUpdated",
    inputs: [
      {
        name: "subscriptionId",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "keyHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "confirmations",
        type: "uint16",
        indexed: false,
        internalType: "uint16",
      },
      {
        name: "gasBase",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
      {
        name: "gasPerSpin",
        type: "uint32",
        indexed: false,
        internalType: "uint32",
      },
      {
        name: "nativePayment",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BadBatch",
    inputs: [],
  },
  {
    type: "error",
    name: "BadPool",
    inputs: [],
  },
  {
    type: "error",
    name: "EmptyPool",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOperator",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOwnerOrOperator",
    inputs: [],
  },
  {
    type: "error",
    name: "OnlyCoordinatorCanFulfill",
    inputs: [
      {
        name: "have",
        type: "address",
        internalType: "address",
      },
      {
        name: "want",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "OnlyOwnerOrCoordinator",
    inputs: [
      {
        name: "have",
        type: "address",
        internalType: "address",
      },
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
      {
        name: "coordinator",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "PoolLocked",
    inputs: [],
  },
  {
    type: "error",
    name: "RequestsPaused",
    inputs: [],
  },
  {
    type: "error",
    name: "SpinExists",
    inputs: [
      {
        name: "spinId",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
] as const;
