// Generated from contracts/out/GotchaVRF.sol/GotchaVRF.json (subset used by the app).
export const gotchaVrfAbi = [
  {
    "type": "function",
    "name": "getPool",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct GotchaVRF.Prize[]",
        "components": [
          {
            "name": "weight",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "remaining",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getSpin",
    "inputs": [
      {
        "name": "spinId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct GotchaVRF.Spin",
        "components": [
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum GotchaVRF.Status"
          },
          {
            "name": "prizeIndex",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "requestedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "requestId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "randomWord",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getSpins",
    "inputs": [
      {
        "name": "spinIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "out",
        "type": "tuple[]",
        "internalType": "struct GotchaVRF.Spin[]",
        "components": [
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum GotchaVRF.Status"
          },
          {
            "name": "prizeIndex",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "requestedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "requestId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "randomWord",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "operator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingRequests",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "poolVersion",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "requestSpins",
    "inputs": [
      {
        "name": "spinIds",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "requestId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setPool",
    "inputs": [
      {
        "name": "weights",
        "type": "uint32[]",
        "internalType": "uint32[]"
      },
      {
        "name": "remaining",
        "type": "uint32[]",
        "internalType": "uint32[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "SpinFulfilled",
    "inputs": [
      {
        "name": "spinId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "requestId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "randomWord",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "prizeIndex",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "SpinRequested",
    "inputs": [
      {
        "name": "spinId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "requestId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadBatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadPool",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyPool",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOperator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwnerOrOperator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PoolLocked",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SpinExists",
    "inputs": [
      {
        "name": "spinId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  }
] as const;
