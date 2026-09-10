-include .env

.PHONY: all test clean deploy compile-aqua help snapshot format anvil

DEFAULT_ANVIL_KEY := 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

all: clean update build

# Clean the repo
clean:
	forge clean

# Update Dependencies
update:
	forge update

build:
	forge build

test:
	forge test

snapshot:
	forge snapshot

format:
	forge fmt

# Run local Anvil node with Mainnet fork (Crucial for MarginMM Aave integration)
anvil:
	anvil -m 'test test test test test test test test test test test junk' --fork-url $(ETH_RPC_URL) --fork-block-number 25913344 --chain-id 31337 --steps-tracing --block-time 1
	
NETWORK_ARGS := --rpc-url http://localhost:8545 --private-key $(DEFAULT_ANVIL_KEY) --broadcast

# If --network mainnet is passed (Uses your .env Alchemy RPC)
ifeq ($(findstring --network mainnet,$(ARGS)),--network mainnet)
    NETWORK_ARGS := --rpc-url $(ETH_RPC_URL) --private-key $(PRIVATE_KEY) --broadcast 
endif

# Deploy MarginMM Core Architecture
deploy:
	@forge script script/DeployMarginMM.s.sol:DeployMarginMM $(NETWORK_ARGS)

# Force Aqua artifact generation for frontend bootstrapping
compile-aqua:
	@forge script script/BootstrapDemo.s.sol $(NETWORK_ARGS)