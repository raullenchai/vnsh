class Vnsh < Formula
  desc "The Ephemeral Dropbox for AI - Host-blind encrypted file sharing"
  homepage "https://vnsh.dev"
  url "https://github.com/raullenchai/vnsh/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "PLACEHOLDER_SHA256"
  license "MIT"
  head "https://github.com/raullenchai/vnsh.git", branch: "main"

  depends_on "openssl"

  def install
    bin.install "cli/vn"
  end

  test do
    assert_match "vn 1.0.0", shell_output("#{bin}/vn --version")
  end
end
