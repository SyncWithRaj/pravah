#!/usr/bin/env bash
set -e

echo "=========================================================="
echo "Setting up AWS EC2 Instance for Pravah CDN Node"
echo "=========================================================="

# 1. Update system packages
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release git make

# 2. Add Docker official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
fi

# 3. Set up Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 4. Install Docker Engine and Compose Plugin
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 5. Add current user to docker group
sudo usermod -aG docker "$USER"

# 6. Enable and start Docker
sudo systemctl enable docker
sudo systemctl start docker

echo "=========================================================="
echo "Docker & Docker Compose installed successfully."
echo "Please log out and log back in (or run 'newgrp docker') to use docker without sudo."
echo "=========================================================="
