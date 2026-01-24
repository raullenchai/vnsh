class Vnsh < Formula
  desc "The Ephemeral Dropbox for AI - Host-blind encrypted file sharing"
  homepage "https://vnsh.dev"
  url "https://github.com/raullenchai/vnsh/archive/refs/tags/v1.1.0.tar.gz"
  sha256 "f62b0b45a666e2e8dd3fb57ee92019acd326357fa6958575586189194d75b6fd"
  license "MIT"
  head "https://github.com/raullenchai/vnsh.git", branch: "main"

  depends_on "openssl"

  def install
    bin.install "cli/vn"
  end

  test do
    assert_match "vn 1.1.0", shell_output("#{bin}/vn --version")
  end
end
